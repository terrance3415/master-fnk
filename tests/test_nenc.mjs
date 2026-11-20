import assert from "node:assert/strict";
import test from "node:test";

import { HEADER_SIZE, decryptBytes, encryptBytes } from "../web/src/nenc.mjs";

test("nenc round trip uses a 54 byte header", async () => {
  const plain = new TextEncoder().encode("phone-film");
  const sealed = await encryptBytes(plain, "correct horse", {
    chunkSize: 4,
    kdfParams: { n: 1024, r: 8, p: 1 },
  });
  assert.equal(sealed[0], 0x4e);
  assert.equal(HEADER_SIZE, 54);
  const opened = await decryptBytes(sealed, "correct horse");
  assert.equal(new TextDecoder().decode(opened), "phone-film");
  await assert.rejects(() => decryptBytes(sealed, "wrong password"));
});
