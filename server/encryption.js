import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import crypto from 'crypto';

/**
 * Split binary data into chunks
 * @param {Buffer} data - The binary data to split
 * @param {number} chunkSize - Size of each chunk in bytes (default 3MB)
 * @returns {Array<Buffer>} Array of chunks
 */
function splitIntoChunks(data, chunkSize = 3 * 1024 * 1024) {
    const chunks = [];
    let offset = 0;

    while (offset < data.length) {
        const end = Math.min(offset + chunkSize, data.length);
        chunks.push(data.slice(offset, end));
        offset = end;
    }

    return chunks;
}

/**
 * Generate Kyber key pair
 * @returns {Object} { publicKey, secretKey }
 */
function generateKeyPair() {
    const seed = crypto.randomBytes(64); // ML-KEM-768 requires 64 bytes of randomness
    const keys = ml_kem768.keygen(seed);

    return {
        publicKey: Buffer.from(keys.publicKey),
        secretKey: Buffer.from(keys.secretKey)
    };
}

/**
 * Encrypt a chunk using Kyber
 * @param {Buffer} chunk - The data chunk to encrypt
 * @param {Buffer} publicKey - The Kyber public key
 * @returns {Object} { ciphertext, sharedSecret }
 */
function encryptChunk(chunk, publicKey) {
    // Generate encapsulation (creates shared secret)
    const encapResult = ml_kem768.encapsulate(publicKey);
    const sharedSecret = Buffer.from(encapResult.sharedSecret);
    const ciphertext = Buffer.from(encapResult.cipherText);

    // Use shared secret to derive AES key
    const aesKey = crypto.createHash('sha256').update(sharedSecret).digest();

    // Encrypt the chunk with AES-256-GCM
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);

    const encryptedData = Buffer.concat([
        cipher.update(chunk),
        cipher.final()
    ]);

    const authTag = cipher.getAuthTag();

    // Combine: ciphertext + iv + authTag + encryptedData
    return {
        kyberCiphertext: ciphertext,
        encryptedChunk: Buffer.concat([iv, authTag, encryptedData])
    };
}

/**
 * Decrypt a chunk using Kyber
 * @param {Buffer} kyberCiphertext - The Kyber ciphertext
 * @param {Buffer} encryptedChunk - The encrypted chunk data
 * @param {Buffer} secretKey - The Kyber secret key
 * @returns {Buffer} Decrypted chunk
 */
function decryptChunk(kyberCiphertext, encryptedChunk, secretKey) {
    // Decapsulate to get shared secret
    const sharedSecret = Buffer.from(ml_kem768.decapsulate(kyberCiphertext, secretKey));

    // Derive AES key from shared secret
    const aesKey = crypto.createHash('sha256').update(sharedSecret).digest();

    // Extract IV, auth tag, and encrypted data
    const iv = encryptedChunk.slice(0, 12);
    const authTag = encryptedChunk.slice(12, 28);
    const encryptedData = encryptedChunk.slice(28);

    // Decrypt with AES-256-GCM
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
        decipher.update(encryptedData),
        decipher.final()
    ]);

    return decrypted;
}

export {
    splitIntoChunks,
    generateKeyPair,
    encryptChunk,
    decryptChunk
};
