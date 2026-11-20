/** Exposure, white balance, contrast, and the teal-orange movie grade. No browser APIs. */

function clampByte(value) {
  if (value < 0) return 0;
  if (value > 255) return 255;
  return value | 0;
}

export function applyCorrection(rgba, options = {}) {
  const exposure = Number(options.exposure) || 0;
  const temperature = Number(options.temperature) || 0;
  const tint = Number(options.tint) || 0;
  const contrast = Number(options.contrast) || 0;
  const gain = 2 ** Math.max(-2, Math.min(2, exposure));
  const warm = Math.max(-1, Math.min(1, temperature));
  const magenta = Math.max(-1, Math.min(1, tint));
  const contrastGain = 1 + Math.max(-1, Math.min(1, contrast));
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    let r = rgba[i] * gain + warm * 28 + magenta * 14;
    let g = rgba[i + 1] * gain - magenta * 18;
    let b = rgba[i + 2] * gain - warm * 28 + magenta * 14;
    r = (r - 128) * contrastGain + 128;
    g = (g - 128) * contrastGain + 128;
    b = (b - 128) * contrastGain + 128;
    out[i] = clampByte(Math.round(r));
    out[i + 1] = clampByte(Math.round(g));
    out[i + 2] = clampByte(Math.round(b));
    out[i + 3] = rgba[i + 3];
  }
  return out;
}

/** Teal shadows, orange highlights, deeper shadows, lifted blacks. amount 0 is a copy. */
export function applyCinematic(rgba, amount = 0) {
  const strength = Math.max(0, Math.min(1, Number(amount) || 0));
  const out = new Uint8ClampedArray(rgba.length);
  if (strength === 0) {
    out.set(rgba);
    return out;
  }
  const toe = 12 * strength;
  for (let i = 0; i < rgba.length; i += 4) {
    let r = rgba[i];
    let g = rgba[i + 1];
    let b = rgba[i + 2];
    const y = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 255;
    const shadow = Math.max(0, 1 - y * 1.6) * strength;
    const high = Math.max(0, y - 0.45) * strength;
    r = r * (1 - 0.22 * shadow) + 18 * high;
    g = g * (1 - 0.06 * shadow) + 10 * shadow + 6 * high;
    b = b * (1 - 0.28 * high) + 22 * shadow;
    const crushed = (y ** (1 + 0.55 * strength));
    const mix = 0.35 * strength;
    r = r * (1 - mix) + r * crushed * mix + (1 - crushed) * r * (1 - mix);
    g = g * (1 - mix) + g * crushed * mix;
    b = b * (1 - mix) + b * crushed * mix;
    const lift = (1 - y) * toe;
    out[i] = clampByte(Math.round(r * (1 - strength * 0.15) + lift * 0.7));
    out[i + 1] = clampByte(Math.round(g + lift * 0.85));
    out[i + 2] = clampByte(Math.round(b + lift));
    out[i + 3] = rgba[i + 3];
  }
  return out;
}

export function applyGradeAndCorrection(rgba, options = {}) {
  const graded = applyCinematic(rgba, options.cinematic || 0);
  return applyCorrection(graded, options);
}

/** Gray-world white balance and a gentle exposure nudge toward mid gray. */
export function suggestCorrection(rgba) {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const step = Math.max(4, Math.floor(rgba.length / 4 / 4000) * 4);
  for (let i = 0; i < rgba.length; i += step) {
    r += rgba[i];
    g += rgba[i + 1];
    b += rgba[i + 2];
    n++;
  }
  if (!n) return { exposure: 0, temperature: 0, tint: 0, contrast: 0 };
  r /= n;
  g /= n;
  b /= n;
  const y = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 255;
  const exposure = Math.max(-1.5, Math.min(1.5, Math.log2(Math.max(0.08, 0.46) / Math.max(0.04, y))));
  const temperature = Math.max(-1, Math.min(1, (b - r) / 80));
  const tint = Math.max(-1, Math.min(1, ((r + b) / 2 - g) / 80));
  return { exposure, temperature, tint, contrast: y < 0.25 || y > 0.75 ? 0.08 : 0 };
}
