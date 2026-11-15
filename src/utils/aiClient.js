// Shared AI client for the OCR / extraction routes (scale weight, QC IV, packing lists).
//
// Providers:
//   claude  Anthropic Messages API (ANTHROPIC_API_KEY). Paid from the Console org's API credits.
//   openai  OpenAI Chat Completions (OPENAI_API_KEY). The previous engine, kept as a fallback.
//
// .env:
//   AI_PROVIDER     claude | openai. Default: claude if ANTHROPIC_API_KEY is set, else openai.
//   AI_FALLBACK     on | off (default on). If the primary provider errors (credit balance used up,
//                   outage, timeout), retry once on the other provider when its key is configured.
//   CLAUDE_MODEL    default claude-haiku-5-5
//   OPENAI_MODEL    default gpt-4o-mini
//   AI_TIMEOUT_MS   default 30000
//
// Every function returns { text, provider }. They throw AiError when no provider can answer,
// so routes keep their existing 502 handling.

let sharp = null;
try {
  // Optional: shrinks phone photos before upload (Claude rejects base64 images over 5 MB, and
  // smaller images cost fewer tokens). Without it, images are sent as-is.
  sharp = require('sharp');
} catch {
  sharp = null;
}

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const TIMEOUT_MS = parseInt(process.env.AI_TIMEOUT_MS, 10) || 30000;

const CLAUDE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const CLAUDE_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_EDGE_PX = 1568; // Claude downscales anything larger anyway

class AiError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'AiError';
    this.details = details;
  }
}

const hasKey = (provider) =>
  provider === 'claude' ? !!process.env.ANTHROPIC_API_KEY : !!process.env.OPENAI_API_KEY;

const primaryProvider = () => {
  const p = (process.env.AI_PROVIDER || '').trim().toLowerCase();
  if (p === 'claude' || p === 'openai') return p;
  return process.env.ANTHROPIC_API_KEY ? 'claude' : 'openai';
};

/** Providers to try, in order. Empty when nothing is configured. */
const providerChain = () => {
  const primary = primaryProvider();
  const other = primary === 'claude' ? 'openai' : 'claude';
  const chain = [];
  if (hasKey(primary)) chain.push(primary);
  const fallbackOn = (process.env.AI_FALLBACK || 'on').trim().toLowerCase() !== 'off';
  if ((fallbackOn || chain.length === 0) && hasKey(other)) chain.push(other);
  return chain;
};

const isConfigured = () => providerChain().length > 0;

/** Resize/re-encode large or unsupported images to a JPEG that fits Claude's limits. */
const prepareImage = async (buffer, mime) => {
  const type = (mime || 'image/jpeg').toLowerCase();
  const fits = buffer.length <= CLAUDE_MAX_IMAGE_BYTES && CLAUDE_IMAGE_TYPES.includes(type);
  if (!sharp) return { buffer, mime: type };
  try {
    const meta = await sharp(buffer).metadata();
    const longEdge = Math.max(meta.width || 0, meta.height || 0);
    if (fits && longEdge <= MAX_IMAGE_EDGE_PX) return { buffer, mime: type };
    const out = await sharp(buffer)
      .rotate() // respect EXIF orientation from phone cameras
      .resize({ width: MAX_IMAGE_EDGE_PX, height: MAX_IMAGE_EDGE_PX, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    return { buffer: out, mime: 'image/jpeg' };
  } catch (err) {
    console.warn('AI image prepare failed, sending original:', err.message);
    return { buffer, mime: type };
  }
};

// ─── Provider calls ────────────────────────────────────────────────────────────

const callClaude = async (content, maxTokens) => {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      temperature: 0,
      messages: [{ role: 'user', content }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Claude ${res.status}: ${errText.slice(0, 500)}`);
  }
  const json = await res.json();
  return (json?.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
};

const callOpenAI = async (content, maxTokens) => {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      max_tokens: maxTokens,
      temperature: 0,
      messages: [{ role: 'user', content }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`OpenAI ${res.status}: ${errText.slice(0, 500)}`);
  }
  const json = await res.json();
  return (json?.choices?.[0]?.message?.content || '').trim();
};

/**
 * Runs `build(provider)` → { content, maxTokens } on each provider in the chain until one works.
 * `build` may return null to skip a provider (e.g. OpenAI can't take a scanned PDF).
 */
const runChain = async (label, build) => {
  const chain = providerChain();
  if (chain.length === 0) throw new AiError('AI is not configured (set ANTHROPIC_API_KEY or OPENAI_API_KEY)');
  const failures = [];
  for (const provider of chain) {
    const req = await build(provider);
    if (!req) continue;
    try {
      const text = provider === 'claude'
        ? await callClaude(req.content, req.maxTokens)
        : await callOpenAI(req.content, req.maxTokens);
      if (failures.length) console.warn(`${label}: answered by ${provider} after fallback`);
      return { text, provider };
    } catch (err) {
      console.error(`${label} via ${provider} failed:`, err.message);
      failures.push(`${provider}: ${err.message}`);
    }
  }
  throw new AiError(`${label} failed on all providers`, failures);
};

// ─── Public helpers ────────────────────────────────────────────────────────────

/** Ask about one image. */
const askImage = async ({ buffer, mime, prompt, maxTokens = 50, label = 'AI image' }) => {
  const prepared = await prepareImage(buffer, mime);
  const base64 = prepared.buffer.toString('base64');
  return runChain(label, (provider) => {
    if (provider === 'claude') {
      if (prepared.buffer.length > CLAUDE_MAX_IMAGE_BYTES || !CLAUDE_IMAGE_TYPES.includes(prepared.mime)) {
        console.warn(`${label}: image not accepted by Claude (${prepared.mime}, ${prepared.buffer.length} bytes)`);
        return null;
      }
      return {
        maxTokens,
        content: [
          { type: 'image', source: { type: 'base64', media_type: prepared.mime, data: base64 } },
          { type: 'text', text: prompt },
        ],
      };
    }
    return {
      maxTokens,
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${prepared.mime};base64,${base64}` } },
      ],
    };
  });
};

/**
 * Ask about a PDF. Claude reads the PDF itself (works for scanned PDFs too); OpenAI gets the
 * extracted text, so it is skipped when the PDF has no text layer.
 */
const askPdf = async ({ buffer, text, prompt, maxTokens = 500, label = 'AI PDF' }) =>
  runChain(label, (provider) => {
    if (provider === 'claude') {
      return {
        maxTokens,
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
          { type: 'text', text: prompt },
        ],
      };
    }
    if (!text) return null;
    return {
      maxTokens,
      content: `${prompt}\n\nDOCUMENT TEXT:\n"""\n${text.slice(0, 12000)}\n"""`,
    };
  });

/** True when a PDF with no text layer can still be read (only Claude can do that). */
const canReadScannedPdf = () => providerChain().includes('claude');

module.exports = { askImage, askPdf, isConfigured, canReadScannedPdf, primaryProvider, AiError };
