// ─── Flux E2E Encryption — ECDH P-256 + AES-GCM ─────────────────────────────
// Private keys are generated once per device, stored in IndexedDB as
// non-extractable CryptoKey objects, and never sent anywhere.
// Public keys are registered on the server so peers can fetch them.
// DMs:    ECDH(myPrivate, theirPublic) → HKDF → AES-256-GCM per message.
// Groups: Random AES-256-GCM group key, wrapped per-member with the same ECDH
//         derivation, stored encrypted on the server.

export const E2E_PREFIX     = "[E2E]";   // DM ciphertext marker
export const E2E_GRP_PREFIX = "[E2EG]";  // group ciphertext marker

// ─── IndexedDB key store ──────────────────────────────────────────────────────
const IDB_NAME  = "flux-e2e-v1";
const IDB_STORE = "keys";

function openKS(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess       = () => res(req.result);
    req.onerror         = () => rej(req.error);
  });
}

async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openKS();
  return new Promise(res => {
    const req = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(key);
    req.onsuccess = () => res((req.result as T) ?? null);
    req.onerror   = () => res(null);
  });
}

async function idbPut(key: string, value: unknown): Promise<void> {
  const db = await openKS();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => res();
    tx.onerror    = () => rej(tx.error);
  });
}

// ─── Base64 helpers ───────────────────────────────────────────────────────────
const toB64   = (buf: ArrayBuffer | Uint8Array) => {
  const arr = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return btoa(String.fromCharCode(...arr));
};
const fromB64 = (s: string) =>
  Uint8Array.from(atob(s), c => c.charCodeAt(0));

// ─── Identity key pair ────────────────────────────────────────────────────────
/**
 * Returns the identity ECDH key pair for the given user email.
 * Generates and persists on first call; reads from IndexedDB on subsequent calls.
 * publicKeyB64 is the raw P-256 public key encoded as base64 — register this
 * on the server via POST /profile/public-key.
 */
export async function getOrCreateIdentityKeyPair(
  userEmail: string,
): Promise<{ privateKey: CryptoKey; publicKeyB64: string }> {
  const storedPriv = await idbGet<CryptoKey>(`priv_${userEmail}`);
  const storedPub  = await idbGet<string>(`pub_${userEmail}`);

  if (storedPriv && storedPub) {
    return { privateKey: storedPriv, publicKeyB64: storedPub };
  }

  const kp = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,         // private key non-extractable — stays in IDB only
    ["deriveKey"],
  );

  const rawPub = await crypto.subtle.exportKey("raw", kp.publicKey);
  const pub64  = toB64(rawPub);

  await idbPut(`priv_${userEmail}`, kp.privateKey);
  await idbPut(`pub_${userEmail}`,  pub64);

  return { privateKey: kp.privateKey, publicKeyB64: pub64 };
}

// ─── Import a peer's public key from base64 ───────────────────────────────────
async function importPub(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    fromB64(b64),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
}

// ─── Derive a per-conversation AES-GCM key via ECDH + HKDF ───────────────────
async function deriveAES(
  myPriv: CryptoKey,
  theirPubB64: string,
  info = "flux-dm-v1",
): Promise<CryptoKey> {
  const theirPub = await importPub(theirPubB64);

  // Step 1: raw ECDH shared secret → exportable bits
  const rawBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: theirPub },
    myPriv,
    256,
  );

  // Step 2: HKDF to get a proper AES key (domain-separated by `info`)
  const hkdfKey = await crypto.subtle.importKey("raw", rawBits, "HKDF", false, ["deriveKey"]);

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt:  new Uint8Array(32),            // zero salt (no shared context needed)
      info:  new TextEncoder().encode(info),
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// ─── DM encrypt / decrypt ─────────────────────────────────────────────────────
/**
 * Encrypt a plaintext string for a specific recipient.
 * Returns a string like "[E2E]<iv_b64>.<ct_b64>" safe to store as message content.
 */
export async function encryptDM(
  plaintext:   string,
  myPriv:      CryptoKey,
  theirPubB64: string,
): Promise<string> {
  const key = await deriveAES(myPriv, theirPubB64);
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const ct  = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `${E2E_PREFIX}${toB64(iv)}.${toB64(ct)}`;
}

/**
 * Decrypt a "[E2E]…" ciphertext received from a peer.
 */
export async function decryptDM(
  ciphertext:  string,
  myPriv:      CryptoKey,
  theirPubB64: string,
): Promise<string> {
  const payload       = ciphertext.slice(E2E_PREFIX.length);
  const [ivB64, ctB64] = payload.split(".");
  if (!ivB64 || !ctB64) throw new Error("Bad E2E ciphertext format");

  const key = await deriveAES(myPriv, theirPubB64);
  const pt  = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(ivB64) },
    key,
    fromB64(ctB64),
  );
  return new TextDecoder().decode(pt);
}

// ─── Group key management ─────────────────────────────────────────────────────
export interface GroupKeyBundle {
  keyId:      string;   // UUID, used to rotate keys
  groupKey:   CryptoKey;
}

/**
 * Generate a fresh random AES-256 group key.
 */
export async function generateGroupKey(): Promise<GroupKeyBundle> {
  const groupKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,             // must be exportable so we can wrap it for each member
    ["encrypt", "decrypt"],
  );
  return { keyId: crypto.randomUUID(), groupKey };
}

/**
 * Wrap (encrypt) a group key for a specific member.
 * Uses the same ECDH derivation so no extra ceremony is needed.
 * Returns a base64 string: "<iv_b64>.<wrapped_b64>"
 */
export async function wrapGroupKeyForMember(
  bundle:         GroupKeyBundle,
  adminPriv:      CryptoKey,
  memberPubB64:   string,
): Promise<string> {
  const wrapKey = await deriveAES(adminPriv, memberPubB64, "flux-group-wrap-v1");
  const rawKey  = await crypto.subtle.exportKey("raw", bundle.groupKey);
  const iv      = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrapKey, rawKey);
  return `${toB64(iv)}.${toB64(wrapped)}`;
}

/**
 * Unwrap (decrypt) a group key received from the server.
 * `senderPubB64` is the public key of whoever wrapped it (the group creator/admin).
 */
export async function unwrapGroupKey(
  encryptedKey:  string,
  myPriv:        CryptoKey,
  senderPubB64:  string,
): Promise<CryptoKey> {
  const [ivB64, wrappedB64] = encryptedKey.split(".");
  const wrapKey = await deriveAES(myPriv, senderPubB64, "flux-group-wrap-v1");
  const rawKey  = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(ivB64) },
    wrapKey,
    fromB64(wrappedB64),
  );
  return crypto.subtle.importKey(
    "raw", rawKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt a group message with the group's AES key.
 * Returns "[E2EG]<iv_b64>.<ct_b64>"
 */
export async function encryptGroupMsg(
  plaintext: string,
  groupKey:  CryptoKey,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    groupKey,
    new TextEncoder().encode(plaintext),
  );
  return `${E2E_GRP_PREFIX}${toB64(iv)}.${toB64(ct)}`;
}

/**
 * Decrypt a "[E2EG]…" group message.
 */
export async function decryptGroupMsg(
  ciphertext: string,
  groupKey:   CryptoKey,
): Promise<string> {
  const payload        = ciphertext.slice(E2E_GRP_PREFIX.length);
  const [ivB64, ctB64] = payload.split(".");
  if (!ivB64 || !ctB64) throw new Error("Bad E2EG ciphertext format");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(ivB64) },
    groupKey,
    fromB64(ctB64),
  );
  return new TextDecoder().decode(pt);
}

// ─── Convenience predicates ───────────────────────────────────────────────────
export const isDMEncrypted    = (c: string) => c.startsWith(E2E_PREFIX);
export const isGroupEncrypted = (c: string) => c.startsWith(E2E_GRP_PREFIX);
export const isEncrypted      = (c: string) => isDMEncrypted(c) || isGroupEncrypted(c);

// ─── In-memory group key cache ────────────────────────────────────────────────
// Keyed by group_id string. Populated after unwrapGroupKey succeeds.
export const groupKeyCache = new Map<string, CryptoKey>();
