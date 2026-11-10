import assert from "node:assert/strict";
import test from "node:test";

import {
  MIN_PASSWORD,
  PASSWORD_LOCKOUT_SECONDS,
  PRODUCTION_SCRYPT,
  RECOVERY_LOCKOUT_SECONDS,
  createVault,
  decryptBytes,
  encryptBytes,
  generatePhrase,
  lockoutDelay,
  parsePhrase,
  phraseQuizIndexes,
  recover,
  unlock,
} from "../web/src/vault.mjs";

const FAST = { N: 1024, r: 8, p: 1, dkLen: 32 };

test("lockout waits get longer every time", () => {
  assert.deepEqual(
    PASSWORD_LOCKOUT_SECONDS.map((_, i) => lockoutDelay(PASSWORD_LOCKOUT_SECONDS, i + 1)),
    [...PASSWORD_LOCKOUT_SECONDS],
  );
  for (let i = 1; i < PASSWORD_LOCKOUT_SECONDS.length; i++) {
    assert.ok(PASSWORD_LOCKOUT_SECONDS[i] > PASSWORD_LOCKOUT_SECONDS[i - 1]);
    assert.ok(lockoutDelay(PASSWORD_LOCKOUT_SECONDS, i + 1) >= lockoutDelay(PASSWORD_LOCKOUT_SECONDS, i));
  }
  assert.equal(lockoutDelay(PASSWORD_LOCKOUT_SECONDS, 0), 0);
  assert.equal(lockoutDelay(PASSWORD_LOCKOUT_SECONDS, 99), PASSWORD_LOCKOUT_SECONDS.at(-1));
  for (let i = 1; i < RECOVERY_LOCKOUT_SECONDS.length; i++) {
    assert.ok(RECOVERY_LOCKOUT_SECONDS[i] > RECOVERY_LOCKOUT_SECONDS[i - 1]);
  }
  assert.ok(PRODUCTION_SCRYPT.N >= 2 ** 15);
  assert.ok(MIN_PASSWORD >= 8);
});

test("recovery phrase round-trips and a quiz picks three words", () => {
  for (let i = 0; i < 20; i++) {
    const words = generatePhrase();
    const parsed = parsePhrase(words.join("  ").toUpperCase());
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.words, words);
  }
  let cursor = 0;
  const indexes = phraseQuizIndexes(12, 3, () => {
    cursor += 0.37;
    return cursor % 1;
  });
  assert.equal(new Set(indexes).size, 3);
  assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b));
  assert.equal(parsePhrase("not a real phrase at all here now yes").ok, false);
});

test("password hash, wrong guess, lockout, and recovery keep the film", async () => {
  const phrase = generatePhrase();
  const created = await createVault("correct-horse", phrase, FAST);
  const secret = new TextEncoder().encode("private film");
  const sealed = await encryptBytes(created.vaultKey, secret);
  const opened = await unlock(created.record, "correct-horse", 0);
  assert.equal(new TextDecoder().decode(await decryptBytes(opened.vaultKey, sealed)), "private film");
  assert.equal(opened.record.passwordFailures, 0);

  let record = created.record;
  try {
    await unlock(record, "wrong-password", 1_000);
    assert.fail("wrong password should throw");
  } catch (err) {
    assert.equal(err.code, "auth");
    assert.equal(err.waitSeconds, PASSWORD_LOCKOUT_SECONDS[0]);
    assert.equal(err.record.passwordFailures, 1);
    assert.equal(err.record.passwordLockedUntil, 1_000 + PASSWORD_LOCKOUT_SECONDS[0] * 1000);
    record = err.record;
  }
  await assert.rejects(
    () => unlock(record, "correct-horse", 1_500),
    (err) => {
      assert.equal(err.code, "locked");
      assert.equal(err.record.passwordFailures, 1);
      return true;
    },
  );
  try {
    await unlock(record, "still-wrong", record.passwordLockedUntil);
    assert.fail("second wrong password should throw");
  } catch (err) {
    assert.equal(err.record.passwordFailures, 2);
    assert.equal(err.waitSeconds, PASSWORD_LOCKOUT_SECONDS[1]);
    assert.ok(PASSWORD_LOCKOUT_SECONDS[1] > PASSWORD_LOCKOUT_SECONDS[0]);
    record = err.record;
  }

  const recovered = await recover(record, phrase.join(" "), "brand-new-password", record.passwordLockedUntil + 10);
  assert.equal(recovered.record.passwordFailures, 0);
  assert.equal(recovered.record.passwordLockedUntil, 0);
  const again = await unlock(recovered.record, "brand-new-password", record.passwordLockedUntil + 10);
  assert.equal(new TextDecoder().decode(await decryptBytes(again.vaultKey, sealed)), "private film");
  await assert.rejects(() => unlock(recovered.record, "correct-horse", record.passwordLockedUntil + 10));
});

test("recovery guesses escalate on their own and a bad file does not open", async () => {
  const phrase = generatePhrase();
  const created = await createVault("correct-horse", phrase, FAST);
  const sealed = await encryptBytes(created.vaultKey, new Uint8Array([1, 2, 3, 4]));
  let record = created.record;
  try {
    await recover(record, "one two three four five six seven eight nine ten eleven twelve", "another-password", 5_000);
    assert.fail("bad phrase should throw");
  } catch (err) {
    assert.equal(err.code, "auth");
    assert.equal(err.record.recoveryFailures, 1);
    assert.equal(err.record.passwordFailures, 0);
    assert.equal(err.waitSeconds, RECOVERY_LOCKOUT_SECONDS[0]);
    record = err.record;
  }
  await assert.rejects(() => recover(record, phrase.join(" "), "another-password", 5_100), (err) => err.code === "locked");
  const tampered = { iv: sealed.iv, ct: new Uint8Array(sealed.ct) };
  tampered.ct[0] ^= 0xff;
  await assert.rejects(() => decryptBytes(created.vaultKey, tampered));
});

test("short passwords are refused", async () => {
  await assert.rejects(() => createVault("short", generatePhrase(), FAST), (err) => err.code === "weak");
});
