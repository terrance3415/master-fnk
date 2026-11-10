import assert from "node:assert/strict";
import test from "node:test";

import { denoiseRGBA, estimateShift, isSceneCut, sharpenRGBA } from "../web/src/process.mjs";
import { neuralInputSize, tileStarts } from "../web/src/upscale.mjs";

function energy(data, width, height) {
  let total = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 1; x < width; x++) {
      const i = (y * width + x) * 4;
      const j = i - 4;
      total += Math.abs(data[i] - data[j]);
    }
  }
  return total;
}

test("sharpen raises edge contrast and denoise calms flat noise", () => {
  const width = 32;
  const height = 16;
  const src = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const value = x < width / 2 ? 20 : 210;
      src[i] = src[i + 1] = src[i + 2] = value;
      src[i + 3] = 255;
    }
  }
  const sharp = sharpenRGBA(src, width, height, 1);
  assert.ok(energy(sharp, width, height) > energy(src, width, height));

  let seed = 7;
  const noisy = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < noisy.length; i += 4) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const value = 128 + ((seed >>> 16) % 41) - 20;
    noisy[i] = noisy[i + 1] = noisy[i + 2] = value;
    noisy[i + 3] = 255;
  }
  const quiet = denoiseRGBA(noisy, width, height, 1);
  const variance = (data) => {
    let sum = 0;
    let sum2 = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += data[i];
      sum2 += data[i] * data[i];
      n++;
    }
    const mean = sum / n;
    return sum2 / n - mean * mean;
  };
  assert.ok(variance(quiet) < variance(noisy));
});

test("scene cuts and a global shift are detected", () => {
  const a = new Uint8ClampedArray(16 * 16 * 4).fill(10);
  const b = new Uint8ClampedArray(16 * 16 * 4).fill(200);
  assert.equal(isSceneCut(a, b, 0.3), true);
  assert.equal(isSceneCut(a, a, 0.3), false);
  const width = 32;
  const height = 24;
  const prev = new Uint8Array(width * height);
  const next = new Uint8Array(width * height);
  for (let y = 8; y < 16; y++) {
    for (let x = 8; x < 16; x++) prev[y * width + x] = 255;
    for (let x = 10; x < 18; x++) next[y * width + x] = 255;
  }
  const shift = estimateShift(prev, next, width, height, 4);
  assert.equal(shift.dx, 2);
  assert.equal(shift.dy, 0);
});

test("neural input stays small and tiles cover the frame", () => {
  assert.deepEqual(neuralInputSize(640, 360, 320), { width: 320, height: 180 });
  assert.deepEqual(neuralInputSize(100, 80, 320), { width: 100, height: 80 });
  const starts = tileStarts(320, 192, 16);
  const seen = new Uint8Array(320);
  for (const start of starts) {
    for (let i = start; i < Math.min(320, start + 192); i++) seen[i] = 1;
  }
  assert.ok(seen.every((value) => value === 1));
});
