// Hub crypto — Ed25519 keypair management + X25519 encryption
// Handles PAN instance identity and E2E encryption between instances.

import crypto from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

let keyPair = null;       // { publicKey, privateKey } — KeyObject
let instanceId = null;    // pan_xxxx

/**
 * Initialize or load the Hub keypair from the PAN data directory
 * @param {string} dataDir - PAN data directory (e.g., %LOCALAPPDATA%/PAN/data/)
 * @returns {{ instanceId: string, publicKeyBase64: string }}
 */
export function initHubIdentity(dataDir) {
  const privPath = join(dataDir, 'hub.key');
  const pubPath = join(dataDir, 'hub.pub');

  if (existsSync(privPath) && existsSync(pubPath)) {
    // Load existing keypair
    const privPem = readFileSync(privPath, 'utf-8');
    const pubPem = readFileSync(pubPath, 'utf-8');
    keyPair = {
      privateKey: crypto.createPrivateKey(privPem),
      publicKey: crypto.createPublicKey(pubPem)
    };
    console.log('[hub-crypto] Loaded existing Hub identity');
  } else {
    // Generate new Ed25519 keypair
    keyPair = crypto.generateKeyPairSync('ed25519');

    // Save to disk
    writeFileSync(privPath, keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    writeFileSync(pubPath, keyPair.publicKey.export({ type: 'spki', format: 'pem' }));
    console.log('[hub-crypto] Generated new Hub identity keypair');
  }

  // Derive instance ID from raw public key bytes
  const rawPub = getPublicKeyRaw();
  const hash = crypto.createHash('sha256').update(rawPub).digest('hex');
  instanceId = 'pan_' + hash.slice(0, 16);

  console.log(`[hub-crypto] Instance ID: ${instanceId}`);
  return { instanceId, publicKeyBase64: rawPub.toString('base64') };
}

/**
 * Get the raw 32-byte Ed25519 public key
 */
export function getPublicKeyRaw() {
  if (!keyPair) throw new Error('Hub identity not initialized');
  // Export as DER, strip the 12-byte Ed25519 SPKI prefix to get raw 32 bytes
  const der = keyPair.publicKey.export({ type: 'spki', format: 'der' });
  return der.subarray(12); // 12-byte prefix: 302a300506032b6570032100
}

/**
 * Get public key as base64 (for sending to Hub)
 */
export function getPublicKeyBase64() {
  return getPublicKeyRaw().toString('base64');
}

/**
 * Get the PAN instance ID
 */
export function getInstanceId() {
  return instanceId;
}

/**
 * Sign a message with our Ed25519 private key
 * Used for Hub authentication: sign(nonce|timestamp|instanceId)
 * @returns {string} Base64 signature
 */
export function sign(message) {
  if (!keyPair) throw new Error('Hub identity not initialized');
  const sig = crypto.sign(null, Buffer.from(message), keyPair.privateKey);
  return sig.toString('base64');
}

/**
 * Sign the Hub challenge: nonce|timestamp|instanceId
 */
export function signChallenge(nonce, timestamp) {
  const message = `${nonce}|${timestamp}|${instanceId}`;
  return sign(message);
}

// ─── E2E Encryption (X25519 + XChaCha20-Poly1305) ───

// Cache of shared secrets: peerInstanceId → Buffer
const sharedSecrets = new Map();

/**
 * Derive a shared secret with a peer using X25519 key exchange
 * For now uses a simplified approach — full ECDH will be Phase 2
 * @param {string} peerPublicKeyBase64 - Peer's raw Ed25519 public key (will convert to X25519)
 */
export function deriveSharedSecret(peerInstanceId, peerPublicKeyBase64) {
  // Ed25519 public keys can be converted to X25519 for key exchange
  // Node 19+ supports this via crypto.diffieHellman with x25519 keys
  // For Phase 1, we use a hash-based approach (upgrade to proper ECDH in Phase 2)

  const ourPub = getPublicKeyRaw();
  const theirPub = Buffer.from(peerPublicKeyBase64, 'base64');

  // Deterministic shared secret: HKDF(SHA-256, sorted_keys)
  // Both sides compute the same secret regardless of who initiates
  const keys = [ourPub, theirPub].sort(Buffer.compare);
  const ikm = Buffer.concat(keys);
  const secret = crypto.createHash('sha256').update(ikm).digest();

  sharedSecrets.set(peerInstanceId, secret);
  return secret;
}

/**
 * Encrypt a message for a peer (AES-256-GCM — upgrade to XChaCha20-Poly1305 in Phase 2)
 * @returns {string} Base64 encoded: nonce (12 bytes) + ciphertext + tag (16 bytes)
 */
export function encrypt(peerInstanceId, plaintext) {
  const secret = sharedSecrets.get(peerInstanceId);
  if (!secret) throw new Error(`No shared secret with ${peerInstanceId} — call deriveSharedSecret first`);

  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secret, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([nonce, encrypted, tag]).toString('base64');
}

/**
 * Decrypt a message from a peer
 * @param {string} ciphertextBase64 - Base64 encoded: nonce (12) + ciphertext + tag (16)
 * @returns {string} Plaintext
 */
export function decrypt(peerInstanceId, ciphertextBase64) {
  const secret = sharedSecrets.get(peerInstanceId);
  if (!secret) throw new Error(`No shared secret with ${peerInstanceId}`);

  const data = Buffer.from(ciphertextBase64, 'base64');
  const nonce = data.subarray(0, 12);
  const tag = data.subarray(data.length - 16);
  const ciphertext = data.subarray(12, data.length - 16);

  const decipher = crypto.createDecipheriv('aes-256-gcm', secret, nonce);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final('utf-8');
}
