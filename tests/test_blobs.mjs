import assert from "node:assert/strict";
import test from "node:test";

import { decryptBlobChunked, encryptBlobChunked, spaceMessage } from "../web/src/blobs.mjs";

test("chunked vault storage round-trips and free space is checked", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const payload = crypto.getRandomValues(new Uint8Array(3000));
  const stored = new Map();
  const meta = await encryptBlobChunked(key, new Blob([payload], { type: "video/mp4" }), async (index, part) => {
    stored.set(index, part);
  });
  assert.ok(meta.chunks >= 1);
  const blob = await decryptBlobChunked(key, meta, async (index) => stored.get(index));
  const out = new Uint8Array(await blob.arrayBuffer());
  assert.deepEqual(out, payload);
  assert.match(spaceMessage(1000, 50 * 1024 * 1024), /needs about/);
  assert.equal(spaceMessage(1024 * 1024 * 1024, 1024), null);
});
