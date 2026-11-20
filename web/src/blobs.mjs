/** Chunked AES-GCM storage so a long video is not held as one allocation. */
const CHUNK = 1024 * 1024;

export function bytesNeeded(fileBytes) {
  return Math.ceil(fileBytes * 2.2) + 32 * 1024 * 1024;
}

export function spaceMessage(freeBytes, fileBytes) {
  if (freeBytes == null) return null;
  const need = bytesNeeded(fileBytes);
  if (freeBytes >= need) return null;
  const mb = (value) => Math.max(1, Math.round(value / (1024 * 1024)));
  return `This phone needs about ${mb(need)} MB free for that video and only has about ${mb(freeBytes)} MB. Delete something and try again.`;
}

export async function freeStorageBytes() {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) return null;
  const estimate = await navigator.storage.estimate();
  if (estimate.quota == null) return null;
  return Math.max(0, estimate.quota - (estimate.usage || 0));
}

async function aesGcm(keyBytes, iv, data, encrypt) {
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, [encrypt ? "encrypt" : "decrypt"]);
  const result = await crypto.subtle[encrypt ? "encrypt" : "decrypt"]({ name: "AES-GCM", iv }, key, data);
  return new Uint8Array(result);
}

export async function encryptBlobChunked(vaultKey, blob, put) {
  const size = blob.size;
  const chunkCount = Math.max(1, Math.ceil(size / CHUNK));
  let offset = 0;
  for (let index = 0; index < chunkCount; index++) {
    const end = Math.min(size, offset + CHUNK);
    const plain = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await aesGcm(vaultKey, iv, plain, true);
    await put(index, { iv, ct });
    offset = end;
  }
  return { bytes: size, chunks: chunkCount, type: blob.type || "" };
}

export async function decryptToSink(vaultKey, meta, get, write) {
  for (let index = 0; index < meta.chunks; index++) {
    const saved = await get(index);
    if (!saved) throw new Error("A saved piece of this video is missing.");
    const plain = await aesGcm(vaultKey, saved.iv, saved.ct, false);
    await write(plain);
  }
}

export async function decryptBlobChunked(vaultKey, meta, get) {
  const parts = [];
  await decryptToSink(vaultKey, meta, get, async (plain) => {
    parts.push(plain);
  });
  return new Blob(parts, { type: meta.type || "" });
}

export { CHUNK };
