/** Browser writer/reader for the Nitrate .nenc v1 format. Byte-compatible with nitrate_crypto. */
import { scryptAsync } from "@noble/hashes/scrypt.js";

export const MAGIC = new Uint8Array([0x4e, 0x49, 0x54, 0x52, 0x41, 0x54, 0x45, 0x00]);
export const HEADER_SIZE = 54;
export const SCRYPT_LOW_MEMORY = { n: 2 ** 15, r: 8, p: 1 };
const TAG = 16;

function concat(parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function nonceFor(base, index) {
  const out = new Uint8Array(base);
  let tail = 0n;
  for (let i = 4; i < 12; i++) tail = (tail << 8n) | BigInt(out[i]);
  tail ^= BigInt(index);
  for (let i = 11; i >= 4; i--) {
    out[i] = Number(tail & 0xffn);
    tail >>= 8n;
  }
  return out;
}

function aadFor(header, index, final) {
  const extra = new Uint8Array(9);
  const view = new DataView(extra.buffer);
  view.setUint32(0, Number((BigInt(index) >> 32n) & 0xffffffffn));
  view.setUint32(4, Number(BigInt(index) & 0xffffffffn));
  extra[8] = final ? 1 : 0;
  return concat([header, extra]);
}

function packHeader(kdfId, a, b, c, salt, baseNonce, chunkSize) {
  const header = new Uint8Array(HEADER_SIZE);
  header.set(MAGIC);
  const view = new DataView(header.buffer);
  view.setUint8(8, 1);
  view.setUint8(9, kdfId);
  view.setUint32(10, a);
  view.setUint32(14, b);
  view.setUint32(18, c);
  header.set(salt, 22);
  header.set(baseNonce, 38);
  view.setUint32(50, chunkSize);
  return header;
}

function parseHeader(header) {
  if (header.length < HEADER_SIZE) throw new Error("file too short / not a Nitrate encrypted file");
  for (let i = 0; i < 8; i++) {
    if (header[i] !== MAGIC[i]) throw new Error("not a Nitrate encrypted file (bad magic)");
  }
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const version = view.getUint8(8);
  if (version !== 1) throw new Error(`unsupported format version ${version}`);
  return {
    kdfId: view.getUint8(9),
    a: view.getUint32(10),
    b: view.getUint32(14),
    c: view.getUint32(18),
    salt: header.slice(22, 38),
    baseNonce: header.slice(38, 50),
    chunkSize: view.getUint32(50),
  };
}

async function aes(keyBytes, nonce, data, aad, encrypt) {
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, [encrypt ? "encrypt" : "decrypt"]);
  try {
    const result = await crypto.subtle[encrypt ? "encrypt" : "decrypt"](
      { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 },
      key,
      data,
    );
    return new Uint8Array(result);
  } catch {
    throw new Error("decryption failed: wrong password/key, or the file was modified");
  }
}

async function derive(password, salt, n, r, p) {
  const bytes = typeof password === "string" ? new TextEncoder().encode(password) : password;
  if (!bytes.length) throw new Error("empty password");
  return scryptAsync(bytes, salt, { N: n, r, p, dkLen: 32, maxmem: 256 * 1024 * 1024 });
}

async function readExact(reader, size) {
  const chunks = [];
  let got = 0;
  while (got < size) {
    const part = await reader(size - got);
    if (!part || !part.length) break;
    chunks.push(part);
    got += part.length;
  }
  return concat(chunks);
}

export async function encryptBytes(plain, password, options = {}) {
  const chunkSize = options.chunkSize || 64 * 1024;
  const params = options.kdfParams || SCRYPT_LOW_MEMORY;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const baseNonce = crypto.getRandomValues(new Uint8Array(12));
  const key = options.key || (await derive(password, salt, params.n, params.r, params.p));
  const kdfId = options.key ? 0 : 1;
  const header = packHeader(kdfId, options.key ? 0 : params.n, options.key ? 0 : params.r, options.key ? 0 : params.p, salt, baseNonce, chunkSize);
  const parts = [header];
  let index = 0;
  for (let offset = 0; ; ) {
    const cur = plain.subarray(offset, Math.min(plain.length, offset + chunkSize));
    const nextLen = plain.length - (offset + cur.length);
    const final = nextLen <= 0;
    parts.push(await aes(key, nonceFor(baseNonce, index), cur, aadFor(header, index, final), true));
    if (final) break;
    offset += cur.length;
    index += 1;
  }
  return concat(parts);
}

export async function decryptBytes(bytes, password, keyBytes = null) {
  const header = bytes.subarray(0, HEADER_SIZE);
  const parsed = parseHeader(header);
  let key = keyBytes;
  if (parsed.kdfId === 0) {
    if (!key) throw new Error("this file was encrypted with a session key, not a password");
  } else if (parsed.kdfId === 1) {
    if (password == null) throw new Error("this file was encrypted with a password, not a session key");
    key = await derive(password, parsed.salt, parsed.a, parsed.b, parsed.c);
  } else {
    throw new Error("this browser build opens scrypt and raw-key files");
  }
  const rec = parsed.chunkSize + TAG;
  const plains = [];
  let offset = HEADER_SIZE;
  let index = 0;
  while (offset < bytes.length) {
    const available = bytes.length - offset;
    const take = Math.min(rec, available);
    const cur = bytes.subarray(offset, offset + take);
    if (cur.length < TAG) throw new Error("truncated or corrupt file");
    const final = offset + take >= bytes.length;
    plains.push(await aes(key, nonceFor(parsed.baseNonce, index), cur, aadFor(header, index, final), false));
    if (final) break;
    offset += take;
    index += 1;
  }
  if (!plains.length) throw new Error("truncated or corrupt file");
  return concat(plains);
}

export async function encryptStream(pull, push, password, options = {}) {
  const chunkSize = options.chunkSize || 1024 * 1024;
  const params = options.kdfParams || SCRYPT_LOW_MEMORY;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const baseNonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await derive(password, salt, params.n, params.r, params.p);
  const header = packHeader(1, params.n, params.r, params.p, salt, baseNonce, chunkSize);
  await push(header);
  let index = 0;
  let cur = await readExact(pull, chunkSize);
  for (;;) {
    const nxt = cur.length === chunkSize ? await readExact(pull, chunkSize) : new Uint8Array(0);
    const final = nxt.length === 0;
    await push(await aes(key, nonceFor(baseNonce, index), cur, aadFor(header, index, final), true));
    if (final) return;
    cur = nxt;
    index += 1;
  }
}
