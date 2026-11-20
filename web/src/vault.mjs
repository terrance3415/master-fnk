/**
 * On-phone vault.
 * The password and the recovery phrase are never stored.
 * Each one wraps a random film key with scrypt + AES-GCM.
 * Wrong guesses wait longer every time. The wait is kept in the record,
 * so refreshing the page does not clear it.
 */
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { WORDLIST } from "./wordlist.mjs";

export { WORDLIST };

export const PRODUCTION_SCRYPT = Object.freeze({ N: 32768, r: 8, p: 1, dkLen: 32 });
export const PASSWORD_LOCKOUT_SECONDS = Object.freeze([5, 15, 30, 60, 120, 300, 600, 1800, 3600, 14400]);
export const RECOVERY_LOCKOUT_SECONDS = Object.freeze([30, 120, 600, 1800, 7200, 86400]);
export const MIN_PASSWORD = 8;

export function lockoutDelay(schedule, failures) {
  if (!Number.isFinite(failures) || failures <= 0) return 0;
  const index = Math.min(Math.floor(failures), schedule.length) - 1;
  return schedule[Math.max(0, index)];
}

export class VaultError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = "VaultError";
    this.code = extra.code || "error";
    this.record = extra.record || null;
    this.retryAt = extra.retryAt || 0;
    this.waitSeconds = extra.waitSeconds || 0;
  }
}

function bytesToB64(bytes) {
  let text = "";
  for (const value of bytes) text += String.fromCharCode(value);
  return btoa(text);
}

function b64ToBytes(text) {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function normalizePhrase(text) {
  return String(text || "")
    .normalize("NFKD")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

export function generatePhrase(entropy = randomBytes(16)) {
  if (!(entropy instanceof Uint8Array) || entropy.length !== 16) {
    throw new Error("recovery entropy must be 16 bytes");
  }
  const hash = sha256(entropy);
  const bits = [];
  for (const value of entropy) {
    for (let shift = 7; shift >= 0; shift--) bits.push((value >> shift) & 1);
  }
  for (let shift = 7; shift >= 4; shift--) bits.push((hash[0] >> shift) & 1);
  const words = [];
  for (let word = 0; word < 12; word++) {
    let index = 0;
    for (let bit = 0; bit < 11; bit++) index = (index << 1) | bits[word * 11 + bit];
    words.push(WORDLIST[index]);
  }
  return words;
}

export function parsePhrase(text) {
  const words = normalizePhrase(text).split(" ").filter(Boolean);
  if (words.length !== 12) return { ok: false, reason: "count" };
  const bits = [];
  for (const word of words) {
    const index = WORDLIST.indexOf(word);
    if (index < 0) return { ok: false, reason: "word", word };
    for (let shift = 10; shift >= 0; shift--) bits.push((index >> shift) & 1);
  }
  const entropy = new Uint8Array(16);
  for (let i = 0; i < 128; i++) entropy[i >> 3] |= bits[i] << (7 - (i % 8));
  const hash = sha256(entropy);
  for (let i = 0; i < 4; i++) {
    const expected = (hash[0] >> (7 - i)) & 1;
    if (expected !== bits[128 + i]) return { ok: false, reason: "checksum" };
  }
  return { ok: true, words, normalized: words.join(" ") };
}

export function phraseQuizIndexes(count = 12, pick = 3, random = Math.random) {
  const chosen = [];
  let guard = 0;
  while (chosen.length < pick) {
    if (++guard > count * 20) throw new Error("could not pick recovery words");
    const index = Math.floor(random() * count);
    if (!chosen.includes(index)) chosen.push(index);
  }
  chosen.sort((a, b) => a - b);
  return chosen;
}

async function derive(label, secret, saltB64, kdf) {
  const salt = b64ToBytes(saltB64);
  const material = new TextEncoder().encode(`${label}:${secret}`);
  return scryptAsync(material, salt, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    dkLen: kdf.dkLen || 32,
    maxmem: 64 * 1024 * 1024,
    asyncTick: 8,
  });
}

async function importKey(raw, usages) {
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, usages);
}

async function wrapKey(kek, vaultKey) {
  const iv = randomBytes(12);
  const key = await importKey(kek, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, vaultKey));
  return { iv: bytesToB64(iv), ct: bytesToB64(cipher) };
}

async function unwrapKey(kek, wrapped) {
  const key = await importKey(kek, ["decrypt"]);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64ToBytes(wrapped.iv) },
      key,
      b64ToBytes(wrapped.ct),
    );
    return new Uint8Array(plain);
  } catch {
    return null;
  }
}

function assertPassword(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) {
    throw new VaultError(`Use at least ${MIN_PASSWORD} characters.`, { code: "weak" });
  }
}

function kdfOf(record, override) {
  return override || record.kdf || PRODUCTION_SCRYPT;
}

function lockedError(record, until, now) {
  const waitSeconds = Math.max(1, Math.ceil((until - now) / 1000));
  return new VaultError("Too many tries. Wait, then try again.", {
    code: "locked",
    record,
    retryAt: until,
    waitSeconds,
  });
}

function bump(record, kind, now) {
  const failuresKey = kind === "password" ? "passwordFailures" : "recoveryFailures";
  const untilKey = kind === "password" ? "passwordLockedUntil" : "recoveryLockedUntil";
  const schedule = kind === "password" ? PASSWORD_LOCKOUT_SECONDS : RECOVERY_LOCKOUT_SECONDS;
  const failures = (record[failuresKey] || 0) + 1;
  const wait = lockoutDelay(schedule, failures);
  return {
    ...record,
    [failuresKey]: failures,
    [untilKey]: now + wait * 1000,
  };
}

async function sealSlot(secret, vaultKey, kdf) {
  const salt = bytesToB64(randomBytes(16));
  const id = bytesToB64(randomBytes(9)).replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
  const kek = await derive("password", secret, salt, kdf);
  const wrap = await wrapKey(kek, vaultKey);
  kek.fill(0);
  return { id, salt, wrap };
}

export async function createVault(password, phraseWords, kdf = PRODUCTION_SCRYPT, secondPassword = null) {
  assertPassword(password);
  if (secondPassword != null && secondPassword !== "") assertPassword(secondPassword);
  if (secondPassword && secondPassword === password) {
    throw new VaultError("Use a different second password.", { code: "weak" });
  }
  const parsed = Array.isArray(phraseWords) ? parsePhrase(phraseWords.join(" ")) : parsePhrase(phraseWords);
  if (!parsed.ok) throw new VaultError("The recovery phrase is not valid.", { code: "phrase" });
  const vaultKey = randomBytes(32);
  const otherKey = randomBytes(32);
  const realIndex = randomBytes(1)[0] & 1;
  const otherSecret = secondPassword ? secondPassword : bytesToB64(randomBytes(24));
  const slots = new Array(2);
  slots[realIndex] = await sealSlot(password, vaultKey, kdf);
  slots[1 - realIndex] = await sealSlot(otherSecret, otherKey, kdf);
  const recoverySalt = bytesToB64(randomBytes(16));
  const recoveryKey = await derive("phrase", parsed.normalized, recoverySalt, kdf);
  const payload = new Uint8Array(33);
  payload.set(vaultKey);
  payload[32] = realIndex;
  const record = {
    version: 2,
    kdf: { N: kdf.N, r: kdf.r, p: kdf.p, dkLen: kdf.dkLen || 32 },
    slots,
    recoverySalt,
    recoveryWrap: await wrapKey(recoveryKey, payload),
    passwordFailures: 0,
    passwordLockedUntil: 0,
    recoveryFailures: 0,
    recoveryLockedUntil: 0,
    createdAt: Date.now(),
  };
  recoveryKey.fill(0);
  otherKey.fill(0);
  return { record, vaultKey, phrase: parsed.words, slotId: slots[realIndex].id };
}

export async function unlock(record, password, now = Date.now()) {
  if (record.passwordLockedUntil && now < record.passwordLockedUntil) {
    throw lockedError(record, record.passwordLockedUntil, now);
  }
  const slots = record.version === 2 && Array.isArray(record.slots) ? record.slots : null;
  if (!slots) {
    const passwordKey = await derive("password", password, record.passwordSalt, kdfOf(record));
    const vaultKey = await unwrapKey(passwordKey, record.passwordWrap);
    passwordKey.fill(0);
    if (!vaultKey) return failPassword(record, now);
    return {
      vaultKey,
      slotId: null,
      record: { ...record, passwordFailures: 0, passwordLockedUntil: 0 },
    };
  }
  for (const slot of slots) {
    const passwordKey = await derive("password", password, slot.salt, kdfOf(record));
    const opened = await unwrapKey(passwordKey, slot.wrap);
    passwordKey.fill(0);
    if (opened && opened.length === 32) {
      return {
        vaultKey: opened,
        slotId: slot.id,
        record: { ...record, passwordFailures: 0, passwordLockedUntil: 0 },
      };
    }
  }
  return failPassword(record, now);
}

function failPassword(record, now) {
  const next = bump(record, "password", now);
  const wait = Math.max(1, Math.ceil((next.passwordLockedUntil - now) / 1000));
  throw new VaultError("That password does not match.", {
    code: "auth",
    record: next,
    retryAt: next.passwordLockedUntil,
    waitSeconds: wait,
  });
}

export async function recover(record, phraseText, newPassword, now = Date.now()) {
  assertPassword(newPassword);
  if (record.recoveryLockedUntil && now < record.recoveryLockedUntil) {
    throw lockedError(record, record.recoveryLockedUntil, now);
  }
  const parsed = parsePhrase(phraseText);
  if (!parsed.ok) {
    const next = bump(record, "recovery", now);
    const wait = Math.max(1, Math.ceil((next.recoveryLockedUntil - now) / 1000));
    throw new VaultError("Those words don’t match the recovery phrase.", {
      code: "auth",
      record: next,
      retryAt: next.recoveryLockedUntil,
      waitSeconds: wait,
    });
  }
  const recoveryKey = await derive("phrase", parsed.normalized, record.recoverySalt, kdfOf(record));
  const opened = await unwrapKey(recoveryKey, record.recoveryWrap);
  recoveryKey.fill(0);
  if (!opened) {
    const next = bump(record, "recovery", now);
    const wait = Math.max(1, Math.ceil((next.recoveryLockedUntil - now) / 1000));
    throw new VaultError("Those words don’t match the recovery phrase.", {
      code: "auth",
      record: next,
      retryAt: next.recoveryLockedUntil,
      waitSeconds: wait,
    });
  }
  const passwordSalt = bytesToB64(randomBytes(16));
  const passwordKey = await derive("password", newPassword, passwordSalt, kdfOf(record));
  if (record.version === 2 && opened.length >= 33 && Array.isArray(record.slots)) {
    const vaultKey = opened.subarray(0, 32);
    const index = opened[32];
    const wrap = await wrapKey(passwordKey, vaultKey);
    passwordKey.fill(0);
    const slots = record.slots.map((slot, i) => (i === index ? { ...slot, salt: passwordSalt, wrap } : slot));
    return {
      vaultKey,
      slotId: record.slots[index]?.id || null,
      record: {
        ...record,
        slots,
        passwordFailures: 0,
        passwordLockedUntil: 0,
        recoveryFailures: 0,
        recoveryLockedUntil: 0,
      },
    };
  }
  const vaultKey = opened;
  const passwordWrap = await wrapKey(passwordKey, vaultKey);
  passwordKey.fill(0);
  return {
    vaultKey,
    slotId: null,
    record: {
      ...record,
      passwordSalt,
      passwordWrap,
      passwordFailures: 0,
      passwordLockedUntil: 0,
      recoveryFailures: 0,
      recoveryLockedUntil: 0,
    },
  };
}

export async function encryptBytes(vaultKey, bytes) {
  const iv = randomBytes(12);
  const key = await importKey(vaultKey, ["encrypt"]);
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data));
  return { iv, ct };
}

export async function decryptBytes(vaultKey, payload) {
  const key = await importKey(vaultKey, ["decrypt"]);
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: payload.iv }, key, payload.ct);
    return new Uint8Array(plain);
  } catch {
    throw new VaultError("Saved data could not be opened.", { code: "decrypt" });
  }
}

export function formatWait(seconds) {
  const whole = Math.max(0, Math.ceil(seconds));
  if (whole < 60) return `${whole} second${whole === 1 ? "" : "s"}`;
  const minutes = Math.ceil(whole / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}
