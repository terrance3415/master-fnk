const assert = require("node:assert/strict");
const { tileStarts, coverageMinimum } = require("../worker/infer.js");

const cases = [
  [32, 192, 16],
  [100, 40, 16],
  [48, 32, 8],
  [64, 48, 0],
  [17, 16, 4],
  [192, 192, 16],
  [1080, 192, 16],
];

for (const [length, tile, overlap] of cases) {
  const starts = tileStarts(length, tile, overlap);
  const seen = new Uint8Array(length);
  for (const start of starts) {
    const end = Math.min(length, start + tile);
    assert.ok(start >= 0 && start < length);
    for (let i = start; i < end; i++) seen[i] = 1;
  }
  assert.ok(seen.every((value) => value === 1), `gap for ${length},${tile},${overlap}`);
  const min = coverageMinimum(length, length, tile, overlap);
  assert.ok(min > 0, `coverage hole ${min} for ${length},${tile},${overlap}`);
}

const edge = coverageMinimum(48, 32, 24, 8);
assert.ok(edge > 0);
console.log("tiling ok");
