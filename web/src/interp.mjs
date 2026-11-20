/** Coarse block-matching frame interpolation. Phone-feasible, not optical-flow Farneback. */

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

function luma(rgba, width, x, y) {
  const p = (y * width + x) * 4;
  return rgba[p] * 0.299 + rgba[p + 1] * 0.587 + rgba[p + 2] * 0.114;
}

export function meanAbs(a, b) {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i += 4) {
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    count += 3;
  }
  return count ? sum / count / 255 : 0;
}

function blockSad(prev, next, width, height, x, y, dx, dy, size) {
  let sad = 0;
  let count = 0;
  for (let yy = 0; yy < size; yy += 2) {
    const y0 = y + yy;
    const y1 = y0 + dy;
    if (y0 < 0 || y1 < 0 || y0 >= height || y1 >= height) return 1e9;
    for (let xx = 0; xx < size; xx += 2) {
      const x0 = x + xx;
      const x1 = x0 + dx;
      if (x0 < 0 || x1 < 0 || x0 >= width || x1 >= width) return 1e9;
      sad += Math.abs(luma(prev, width, x0, y0) - luma(next, width, x1, y1));
      count++;
    }
  }
  return count ? sad / count : 1e9;
}

/** Motion of `next` relative to `prev`, one vector per block. */
export function blockFlow(prev, next, width, height, block = 8, radius = 4) {
  const cols = Math.ceil(width / block);
  const rows = Math.ceil(height / block);
  const vectors = new Int16Array(cols * rows * 2);
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      const x = bx * block;
      const y = by * block;
      let best = 0;
      let bestDx = 0;
      let bestDy = 0;
      let first = true;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const sad = blockSad(prev, next, width, height, x, y, dx, dy, block);
          if (first || sad < best) {
            best = sad;
            bestDx = dx;
            bestDy = dy;
            first = false;
          }
        }
      }
      const i = (by * cols + bx) * 2;
      vectors[i] = bestDx;
      vectors[i + 1] = bestDy;
    }
  }
  return { vectors, cols, rows, block };
}

function sample(rgba, width, height, x, y) {
  const xx = clamp(x, 0, width - 1) | 0;
  const yy = clamp(y, 0, height - 1) | 0;
  const p = (yy * width + xx) * 4;
  return [rgba[p], rgba[p + 1], rgba[p + 2], rgba[p + 3]];
}

/**
 * Blend `prev` toward `next` at fraction t (0..1) using block motion.
 * A hard scene cut returns the nearer frame instead of a ghost.
 */
export function interpolateRgba(prev, next, width, height, t, options = {}) {
  const amount = Math.max(0, Math.min(1, Number(t) || 0));
  const out = new Uint8ClampedArray(prev.length);
  if (amount <= 0.001) {
    out.set(prev);
    return out;
  }
  if (amount >= 0.999) {
    out.set(next);
    return out;
  }
  const cut = options.cutThreshold ?? 0.45;
  if (meanAbs(prev, next) >= cut) {
    out.set(amount < 0.5 ? prev : next);
    return out;
  }
  const block = options.block || 8;
  const flow = blockFlow(prev, next, width, height, block, options.radius || 4);
  for (let y = 0; y < height; y++) {
    const by = Math.min(flow.rows - 1, (y / block) | 0);
    for (let x = 0; x < width; x++) {
      const bx = Math.min(flow.cols - 1, (x / block) | 0);
      const vi = (by * flow.cols + bx) * 2;
      const dx = flow.vectors[vi];
      const dy = flow.vectors[vi + 1];
      const a = sample(prev, width, height, x - amount * dx, y - amount * dy);
      const b = sample(next, width, height, x + (1 - amount) * dx, y + (1 - amount) * dy);
      const p = (y * width + x) * 4;
      out[p] = a[0] * (1 - amount) + b[0] * amount;
      out[p + 1] = a[1] * (1 - amount) + b[1] * amount;
      out[p + 2] = a[2] * (1 - amount) + b[2] * amount;
      out[p + 3] = 255;
    }
  }
  return out;
}
