/** Pixel helpers that also run under Node tests. RGBA is tightly packed. */

function clampByte(value) {
  if (value < 0) return 0;
  if (value > 255) return 255;
  return value;
}

export function denoiseRGBA(input, width, height, amount) {
  const strength = Math.min(1, Math.max(0, amount));
  if (strength <= 0) return input;
  const src = input;
  const out = new Uint8ClampedArray(src.length);
  const threshold = 18 + strength * 42;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let w = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = Math.min(height - 1, Math.max(0, y + dy));
          const xx = Math.min(width - 1, Math.max(0, x + dx));
          const j = (yy * width + xx) * 4;
          const dist = Math.abs(src[j] - src[i]) + Math.abs(src[j + 1] - src[i + 1]) + Math.abs(src[j + 2] - src[i + 2]);
          if (dx === 0 && dy === 0 || dist <= threshold) {
            const weight = dx === 0 && dy === 0 ? 4 : 1;
            r += src[j] * weight;
            g += src[j + 1] * weight;
            b += src[j + 2] * weight;
            w += weight;
          }
        }
      }
      const mix = 0.75 * strength;
      out[i] = clampByte(src[i] * (1 - mix) + (r / w) * mix);
      out[i + 1] = clampByte(src[i + 1] * (1 - mix) + (g / w) * mix);
      out[i + 2] = clampByte(src[i + 2] * (1 - mix) + (b / w) * mix);
      out[i + 3] = src[i + 3];
    }
  }
  return out;
}

export function sharpenRGBA(input, width, height, amount) {
  const gain = 1.15 * Math.min(1, Math.max(0, amount));
  if (gain <= 0) return input;
  const src = input;
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const xx = Math.min(width - 1, Math.max(0, x + dx));
        const yy = Math.min(height - 1, Math.max(0, y + dy));
        const j = (yy * width + xx) * 4;
        r += src[j];
        g += src[j + 1];
        b += src[j + 2];
        n += 1;
      }
      const dr = src[i] - r / n;
      const dg = src[i + 1] - g / n;
      const db = src[i + 2] - b / n;
      const magnitude = Math.max(Math.abs(dr), Math.abs(dg), Math.abs(db));
      const weight = Math.min(1, Math.max(0, (magnitude - 3) / 8));
      out[i] = clampByte(Math.round(src[i] + gain * dr * weight));
      out[i + 1] = clampByte(Math.round(src[i + 1] + gain * dg * weight));
      out[i + 2] = clampByte(Math.round(src[i + 2] + gain * db * weight));
      out[i + 3] = src[i + 3];
    }
  }
  return out;
}

export function meanAbsDiff(a, b) {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i += 4) {
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    count += 3;
  }
  return count ? sum / count / 255 : 0;
}

export function isSceneCut(previous, current, threshold) {
  if (threshold <= 0) return true;
  return meanAbsDiff(previous, current) >= threshold;
}

export function grayscale(rgba, width, height) {
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) {
    const p = i * 4;
    gray[i] = (rgba[p] * 0.299 + rgba[p + 1] * 0.587 + rgba[p + 2] * 0.114) | 0;
  }
  return gray;
}

/** Integer shift of `next` relative to `prev`. Used to cancel small camera shake. */
export function estimateShift(prev, next, width, height, radius = 4) {
  let best = { dx: 0, dy: 0, score: Infinity };
  const step = 3;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      let score = 0;
      let count = 0;
      for (let y = radius; y < height - radius; y += step) {
        for (let x = radius; x < width - radius; x += step) {
          const a = prev[y * width + x];
          const b = next[(y + dy) * width + (x + dx)];
          score += Math.abs(a - b);
          count++;
        }
      }
      score = count ? score / count : Infinity;
      if (score < best.score) best = { dx, dy, score };
    }
  }
  return best;
}
