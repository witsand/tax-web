/**
 * db.js — IndexedDB wrapper for tax-web
 */

const DB_NAME = 'taxweb';
const DB_VERSION = 1;
let _db = null;

export async function openDB() {
  if (_db) return _db;
  return (_db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = ({ target: { result: d } }) => {
      const os = (name, key, indices = []) => {
        if (d.objectStoreNames.contains(name)) return;
        const s = d.createObjectStore(name, { keyPath: key });
        indices.forEach(i => s.createIndex(i, i, { unique: false }));
      };
      os('accounts',     'id');
      os('wallets',      'id',   ['accountId']);
      os('transactions', '_key', ['walletId']);
      os('prices_btc',   'time');
      os('prices_usd',   'time');
    };
    req.onsuccess = ({ target: { result } }) => resolve(result);
    req.onerror   = ({ target: { error  } }) => reject(error);
  }));
}

async function rq(fn) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const r = fn(d);
    r.onsuccess = ({ target: { result } }) => resolve(result);
    r.onerror   = ({ target: { error  } }) => reject(error);
  });
}

export const db = {
  get:    (s, k) => rq(d => d.transaction(s).objectStore(s).get(k)),
  getAll: (s)    => rq(d => d.transaction(s).objectStore(s).getAll()),
  put:    (s, v) => rq(d => d.transaction(s, 'readwrite').objectStore(s).put(v)),
  delete: (s, k) => rq(d => d.transaction(s, 'readwrite').objectStore(s).delete(k)),
  clear:  (s)    => rq(d => d.transaction(s, 'readwrite').objectStore(s).clear()),

  putMany: async (s, items) => {
    if (!items.length) return;
    const d = await openDB();
    await new Promise((res, rej) => {
      const tx = d.transaction(s, 'readwrite');
      const st = tx.objectStore(s);
      items.forEach(i => st.put(i));
      tx.oncomplete = res;
      tx.onerror = ({ target: { error } }) => rej(error);
    });
  },

  getByIndex: async (s, idx, val) => {
    const d = await openDB();
    return new Promise((res, rej) => {
      const r = d.transaction(s).objectStore(s).index(idx).getAll(val);
      r.onsuccess = ({ target: { result } }) => res(result);
      r.onerror   = ({ target: { error  } }) => rej(error);
    });
  },

  deleteByIndex: async (s, idx, val) => {
    const d = await openDB();
    await new Promise((res, rej) => {
      const tx = d.transaction(s, 'readwrite');
      const r  = tx.objectStore(s).index(idx).openCursor(IDBKeyRange.only(val));
      r.onsuccess = ({ target: { result: c } }) => { if (c) { c.delete(); c.continue(); } };
      tx.oncomplete = res;
      tx.onerror = ({ target: { error } }) => rej(error);
    });
  },

  latestKey: async (s) => {
    const d = await openDB();
    return new Promise((res, rej) => {
      const r = d.transaction(s).objectStore(s).openCursor(null, 'prev');
      r.onsuccess = ({ target: { result } }) => res(result ? result.key : 0);
      r.onerror   = ({ target: { error  } }) => rej(error);
    });
  },

  asMap: async (s) => {
    const all = await rq(d => d.transaction(s).objectStore(s).getAll());
    return Object.fromEntries(all.map(r => [r.time, r.price]));
  },
};
