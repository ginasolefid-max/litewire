// End-to-End Encryption using standard Web Crypto API:
// - ECDH on NIST P-256 (secp256r1)
// - HKDF-SHA256 bound to conversationId
// - AES-256-GCM with fresh 96-bit CSPRNG IV per message

const KEY_STORAGE_PREFIX = 'litewire_ecdh_v1_';

interface StoredKeyPair {
  publicKeyBase64: string;
  privateKeyJwk: JsonWebKey;
}

function arrayBufferToBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export async function getOrCreateIdentityKeyPair(username: string): Promise<{
  publicKeyBase64: string;
  privateKey: CryptoKey;
}> {
  const storageKey = `${KEY_STORAGE_PREFIX}${username.toLowerCase()}`;
  const existingRaw = localStorage.getItem(storageKey);

  if (existingRaw) {
    try {
      const parsed = JSON.parse(existingRaw) as StoredKeyPair;
      const privateKey = await window.crypto.subtle.importKey(
        'jwk',
        parsed.privateKeyJwk,
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveBits']
      );
      return { publicKeyBase64: parsed.publicKeyBase64, privateKey };
    } catch {
      // Regenerate if corrupted
    }
  }

  const pair = await window.crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );

  const spki = await window.crypto.subtle.exportKey('spki', pair.publicKey);
  const publicKeyBase64 = arrayBufferToBase64(spki);
  const privateKeyJwk = await window.crypto.subtle.exportKey('jwk', pair.privateKey);

  const record: StoredKeyPair = { publicKeyBase64, privateKeyJwk };
  localStorage.setItem(storageKey, JSON.stringify(record));

  return { publicKeyBase64, privateKey: pair.privateKey };
}

async function importPeerPublicKey(publicKeyBase64: string): Promise<CryptoKey> {
  const bytes = base64ToUint8Array(publicKeyBase64);
  return window.crypto.subtle.importKey(
    'spki',
    toArrayBuffer(bytes),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
}

async function deriveConversationAesKey(
  myPrivateKey: CryptoKey,
  peerPublicKeyBase64: string,
  conversationId: string
): Promise<CryptoKey> {
  const peerPub = await importPeerPublicKey(peerPublicKeyBase64);
  const sharedBits = await window.crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPub },
    myPrivateKey,
    256
  );

  const hkdfKey = await window.crypto.subtle.importKey(
    'raw',
    sharedBits,
    'HKDF',
    false,
    ['deriveKey']
  );

  const encoder = new TextEncoder();
  const saltDigest = await window.crypto.subtle.digest(
    'SHA-256',
    encoder.encode(`litewire-e2ee-v1:${conversationId}`)
  );

  return window.crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: saltDigest,
      info: encoder.encode('AES-256-GCM'),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptMessage(
  myPrivateKey: CryptoKey,
  peerPublicKeyBase64: string,
  conversationId: string,
  plaintext: string
): Promise<{ ct: string; iv: string }> {
  const aesKey = await deriveConversationAesKey(myPrivateKey, peerPublicKeyBase64, conversationId);
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();

  const encryptedBuf = await window.crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: encoder.encode(conversationId),
      tagLength: 128,
    },
    aesKey,
    encoder.encode(plaintext)
  );

  return {
    ct: arrayBufferToBase64(encryptedBuf),
    iv: arrayBufferToBase64(iv),
  };
}

export async function decryptMessage(
  myPrivateKey: CryptoKey,
  peerPublicKeyBase64: string,
  conversationId: string,
  ctBase64: string,
  ivBase64: string
): Promise<string> {
  const aesKey = await deriveConversationAesKey(myPrivateKey, peerPublicKeyBase64, conversationId);
  const iv = base64ToUint8Array(ivBase64);
  const ct = base64ToUint8Array(ctBase64);
  const encoder = new TextEncoder();

  const plainBuf = await window.crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(iv),
      additionalData: encoder.encode(conversationId),
      tagLength: 128,
    },
    aesKey,
    toArrayBuffer(ct)
  );

  return new TextDecoder().decode(plainBuf);
}

export async function computeSafetyFingerprint(pubKeyA: string, pubKeyB: string): Promise<string> {
  const sorted = [pubKeyA, pubKeyB].sort().join('|');
  const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(sorted));
  const bytes = new Uint8Array(digest).slice(0, 16);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join('');
  return hex.match(/.{1,4}/g)?.join(' ') || hex;
}
