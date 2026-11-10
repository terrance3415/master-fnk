const DB_NAME = "master-fnk";
const STORE = "kv";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function kvGet(key) {
  const db = await openDb();
  try {
    const result = await requestResult(db.transaction(STORE, "readonly").objectStore(STORE).get(key));
    return result === undefined ? null : result;
  } finally {
    db.close();
  }
}

export async function kvSet(key, value) {
  const db = await openDb();
  try {
    await requestResult(db.transaction(STORE, "readwrite").objectStore(STORE).put(value, key));
  } catch (err) {
    if (err && (err.name === "QuotaExceededError" || err.inner?.name === "QuotaExceededError")) {
      throw new Error("This phone is out of space for saved films. Delete one and try again.");
    }
    throw err;
  } finally {
    db.close();
  }
}

export async function kvDel(key) {
  const db = await openDb();
  try {
    await requestResult(db.transaction(STORE, "readwrite").objectStore(STORE).delete(key));
  } finally {
    db.close();
  }
}

export function wipeDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}
