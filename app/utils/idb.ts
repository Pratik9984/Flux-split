// ─── IDB HELPER ───────────────────────────────────────────────────────────────
export function idbSet(key: string, value: string): void {
  if (typeof indexedDB === "undefined") return;
  try {
    const req = indexedDB.open("Flux-sw", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => {
      const tx = req.result.transaction("kv", "readwrite");
      tx.objectStore("kv").put(value, key);
    };
  } catch { }
}
