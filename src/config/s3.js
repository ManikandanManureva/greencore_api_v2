const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
require('dotenv').config();

const region = process.env.AWS_REGION;
const bucket = process.env.AWS_S3_BUCKET;

const s3Client = (region && bucket)
  ? new S3Client({ region }) // credentials from AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY env vars or IAM role
  : null;

const isS3Configured = () => s3Client !== null;

// The bucket is private, so a raw S3 URL 403s. AWS_S3_PUBLIC_BASE_URL is only for a setup where
// a CloudFront distribution (with its own public access, e.g. an OAC + bucket policy) fronts the
// bucket — in that case the URL works without signing. Otherwise every read goes through a signed URL.
const hasPublicBase = () => !!process.env.AWS_S3_PUBLIC_BASE_URL;

function publicUrlForKey(key) {
  const base = process.env.AWS_S3_PUBLIC_BASE_URL;
  return `${base.replace(/\/+$/, '')}/${key}`;
}

const SIGNED_URL_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 7 days — the max S3 SigV4 allows with static IAM credentials

async function getSignedUrlForKey(key, expiresIn = SIGNED_URL_EXPIRY_SECONDS) {
  if (!isS3Configured()) {
    throw new Error('S3 is not configured (set AWS_REGION and AWS_S3_BUCKET)');
  }
  return getSignedUrl(s3Client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });
}

// Upload the object and hand back whatever URL a client can use *right now* (signed, or the
// public base if configured). The caller should store just the object key, not this URL — the
// URL expires, the key doesn't.
async function uploadBuffer(buffer, key, contentType) {
  if (!isS3Configured()) {
    throw new Error('S3 is not configured (set AWS_REGION and AWS_S3_BUCKET)');
  }
  await s3Client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream',
  }));
  return hasPublicBase() ? publicUrlForKey(key) : getSignedUrlForKey(key);
}

// If `url` points at an object in our bucket (a previously-signed URL, or the public base URL),
// extract and return just its key so it can be stored/compared without the expiring query string.
// Returns null if `url` isn't one of ours (e.g. an old local-disk URL).
function keyFromS3Url(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const base = process.env.AWS_S3_PUBLIC_BASE_URL;
    if (base) {
      const baseUrl = new URL(base);
      if (u.host === baseUrl.host) return decodeURIComponent(u.pathname.replace(/^\/+/, ''));
    }
    if (region && bucket && u.host === `${bucket}.s3.${region}.amazonaws.com`) {
      return decodeURIComponent(u.pathname.replace(/^\/+/, ''));
    }
  } catch {
    return null;
  }
  return null;
}

module.exports = {
  s3Client, bucket, region, isS3Configured,
  uploadBuffer, getSignedUrlForKey, keyFromS3Url,
};
