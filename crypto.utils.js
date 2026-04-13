/**
 * crypto.utils.js
 * AES-256-CBC encryption / decryption for client_name field.
 *
 * KEY  – 32-byte hex string stored in env var ENCRYPTION_KEY
 *        Generate once:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 * IV   – fresh 16-byte random IV prepended to every cipher-text (safe to store in DB).
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';
const KEY_HEX   = process.env.ENCRYPTION_KEY || 'a'.repeat(64); // 32-byte fallback (dev only)
const KEY        = Buffer.from(KEY_HEX, 'hex');

/**
 * Encrypts a plaintext string.
 * @param {string} text - Plaintext to encrypt.
 * @returns {string}    - "<iv_hex>:<ciphertext_hex>" suitable for DB storage.
 */
function encrypt(text) {
    const iv         = crypto.randomBytes(16);
    const cipher     = crypto.createCipheriv(ALGORITHM, KEY, iv);
    const encrypted  = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts a previously encrypted string.
 * @param {string} stored - "<iv_hex>:<ciphertext_hex>" from the DB.
 * @returns {string}      - Original plaintext.
 */
function decrypt(stored) {
    const [ivHex, cipherHex] = stored.split(':');
    const iv         = Buffer.from(ivHex, 'hex');
    const cipherText = Buffer.from(cipherHex, 'hex');
    const decipher   = crypto.createDecipheriv(ALGORITHM, KEY, iv);
    const decrypted  = Buffer.concat([decipher.update(cipherText), decipher.final()]);
    return decrypted.toString('utf8');
}

module.exports = { encrypt, decrypt };
