"""
Reads the weight from a scale display photo with RapidOCR, so no paid API is needed.

A weight is returned only when every rule below passes. Otherwise the result is "no read" and
the operator retakes the photo: a retake costs seconds, a wrong weight goes into the records.

Rules that came from testing 300 real photos (see the notes next to each):
  - The text-direction step stays off. It flipped short numbers upside down (753.0 -> 0E5L) and
    some flips still look valid (595.5 -> 556.5). Operators always photograph the scale upright.
  - Only red LED text counts, so stickers, signs and printed labels can't be taken for the weight.
  - The dot is ignored. A status lamp can read as the dot (613.5 -> 6135.) and the real dot is
    sometimes missed (308.0 -> 3080), but the digits are reliable.
"""
import os
import re

import cv2
import numpy as np
from rapidocr_onnxruntime import RapidOCR

LONG_SIDE_PX = 1600
MIN_CONFIDENCE = 0.80
MIN_RED_FRACTION = 0.03
EDGE_MARGIN = 0.05  # a number this close to the photo edge may have a digit cut off
# Keep MIN_KG at 100 or more: it also catches a lost digit (glare hid the 7 of 753.0, which read 53.0).
MIN_KG = float(os.environ.get('WEIGHT_OCR_MIN_KG', 150))
MAX_KG = float(os.environ.get('WEIGHT_OCR_MAX_KG', 1200))
CPU_THREADS = int(os.environ.get('WEIGHT_OCR_THREADS', 2))

_ocr = RapidOCR(intra_op_num_threads=CPU_THREADS, inter_op_num_threads=1)


def _clean_text(text):
    # Specks beside the digits read as punctuation; S and O are how a seven-segment 5 and 0 look.
    return re.sub(r"[\s'`,:;·]", '', text).replace('S', '5').replace('O', '0')


def _red_fraction(image, x0, y0, x1, y1):
    crop = image[max(0, int(y0)):int(y1), max(0, int(x0)):int(x1)]
    if crop.size == 0:
        return 0.0
    b, g, r = [channel.astype(np.int16) for channel in cv2.split(crop)]
    red = (r > 110) & (r - g > 40) & (r - b > 40)
    overexposed = (r > 235) & (r - b > 40)  # bright LED centres turn orange or yellow
    return float((red | overexposed).mean())


def _number_boxes(results, image):
    boxes = []
    for points, text, confidence in results:
        cleaned = _clean_text(text)
        if not re.fullmatch(r'[\d.]*\d[\d.]*', cleaned):
            continue
        pts = np.array(points, dtype=np.float32)
        x0, x1 = float(pts[:, 0].min()), float(pts[:, 0].max())
        y0, y1 = float(pts[:, 1].min()), float(pts[:, 1].max())
        if _red_fraction(image, x0, y0, x1, y1) < MIN_RED_FRACTION:
            continue
        boxes.append(dict(text=cleaned, confidence=float(confidence), x0=x0, x1=x1, y0=y0, y1=y1,
                          height=y1 - y0, center_y=(y0 + y1) / 2))
    return boxes


def _pick_display_number(boxes):
    """The tallest number, joined with its neighbours: the wide gap beside a 1 can split it in two."""
    top = max(boxes, key=lambda b: b['height'])
    row = sorted(
        (b for b in boxes
         if 0.7 < b['height'] / top['height'] < 1.3 and abs(b['center_y'] - top['center_y']) < top['height'] * 0.4),
        key=lambda b: b['x0'],
    )
    gaps_are_small = all(row[i + 1]['x0'] - row[i]['x1'] < top['height'] * 1.2 for i in range(len(row) - 1))
    if len(row) == 1 or not gaps_are_small:
        return top
    return dict(top, text=''.join(b['text'] for b in row), confidence=min(b['confidence'] for b in row),
                x0=row[0]['x0'], x1=row[-1]['x1'])


def _parse_weight(text):
    digits = text.replace('.', '')
    if not 3 <= len(digits) <= 5 or digits[0] == '0':
        return None
    # A four-digit display has no room for a decimal from 1000 kg up, so it shows whole kg (1003).
    if len(digits) == 4 and digits[0] == '1' and '.' not in text:
        return float(digits)
    return int(digits) / 10  # every scale here shows one decimal place


def read_weight(image):
    """Takes a BGR image. Returns dict(weight, reason, raw, confidence); weight is None for no read."""
    height, width = image.shape[:2]
    scale = min(1.0, LONG_SIDE_PX / max(height, width))
    if scale < 1.0:
        image = cv2.resize(image, (int(width * scale), int(height * scale)), interpolation=cv2.INTER_AREA)
    work_width = image.shape[1]

    results, _ = _ocr(image, use_cls=False)
    boxes = _number_boxes(results or [], image)
    if not boxes:
        return dict(weight=None, reason='no display number found', raw=None, confidence=None)

    number = _pick_display_number(boxes)
    result = dict(weight=None, reason='ok', raw=number['text'], confidence=round(number['confidence'], 3))

    weight = _parse_weight(number['text'])
    if weight is None:
        result['reason'] = 'not a valid weight'
    elif number['confidence'] < MIN_CONFIDENCE:
        result['reason'] = 'low confidence'
    elif number['x0'] < work_width * EDGE_MARGIN or number['x1'] > work_width * (1 - EDGE_MARGIN):
        result['reason'] = 'number too close to the photo edge'
    elif not MIN_KG <= weight <= MAX_KG:
        result['reason'] = 'outside the expected weight range'
    elif (weight * 2) % 1 != 0:
        result['reason'] = 'does not end in .0 or .5'  # the scales move in 0.5 kg steps
    else:
        result['weight'] = weight
    return result
