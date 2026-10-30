// Verschlüsselung des Dokument-Tresors.
// AES-256-GCM, Schlüssel per PBKDF2-SHA256 aus dem Passwort abgeleitet.
// Läuft im Browser und in Node (>= 19) über die WebCrypto-API.

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const VAULT_FORMAT = 'panda-vault';
export const VAULT_VERSION = 1;
export const DEFAULT_ITERATIONS = 600000;

function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function fromBase64(str) {
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

export async function deriveKey(password, salt, iterations = DEFAULT_ITERATIONS) {
  const base = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// Erzeugt einen neuen Schlüssel samt frischem Salt (neuer Tresor / Passwortwechsel).
export async function createKey(password, iterations = DEFAULT_ITERATIONS) {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, iterations);
  return { key, salt, iterations };
}

// Leitet den Schlüssel für einen vorhandenen Tresor ab.
export async function keyForVault(password, vault) {
  checkVault(vault);
  const salt = fromBase64(vault.kdf.salt);
  const key = await deriveKey(password, salt, vault.kdf.iterations);
  return { key, salt, iterations: vault.kdf.iterations };
}

// Verschlüsselt ein beliebiges JSON-Objekt. `updated` bleibt bewusst lesbar,
// damit lokale und entfernte Kopien ohne Passwort verglichen werden können.
export async function encryptVault(data, keyInfo, updated = Date.now()) {
  const iv = randomBytes(12);
  const ad = enc.encode(VAULT_FORMAT + ':' + VAULT_VERSION + ':' + updated);
  const ct = new Uint8Array(await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: ad },
    keyInfo.key,
    enc.encode(JSON.stringify(data))
  ));
  return {
    format: VAULT_FORMAT,
    version: VAULT_VERSION,
    updated,
    kdf: { name: 'PBKDF2-SHA256', iterations: keyInfo.iterations, salt: toBase64(keyInfo.salt) },
    cipher: { name: 'AES-256-GCM', iv: toBase64(iv) },
    data: toBase64(ct)
  };
}

export class WrongPasswordError extends Error {
  constructor() {
    super('Falsches Passwort oder beschädigte Datei');
    this.name = 'WrongPasswordError';
  }
}

export async function decryptVault(vault, keyInfo) {
  checkVault(vault);
  const ad = enc.encode(VAULT_FORMAT + ':' + vault.version + ':' + vault.updated);
  let plain;
  try {
    plain = await subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(vault.cipher.iv), additionalData: ad },
      keyInfo.key,
      fromBase64(vault.data)
    );
  } catch {
    throw new WrongPasswordError();
  }
  return JSON.parse(dec.decode(plain));
}

export function isVault(obj) {
  return !!obj && obj.format === VAULT_FORMAT && typeof obj.data === 'string'
    && !!obj.kdf && !!obj.cipher;
}

function checkVault(vault) {
  if (!isVault(vault)) throw new Error('Keine gültige Tresor-Datei');
  if (vault.version !== VAULT_VERSION) throw new Error('Unbekannte Tresor-Version ' + vault.version);
}

export function sameSalt(vault, keyInfo) {
  return vault.kdf.salt === toBase64(keyInfo.salt) && vault.kdf.iterations === keyInfo.iterations;
}
