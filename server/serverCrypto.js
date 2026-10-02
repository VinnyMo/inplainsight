import crypto from 'crypto';

/**
 * Encrypt data with AES-256-GCM using a derived key
 * @param {Buffer} data - Data to encrypt (Kyber secret key)
 * @param {Buffer} derivedKey - 256-bit key derived from password
 * @param {Buffer} iv - 12-byte IV
 * @returns {Buffer} Encrypted data (includes auth tag)
 */
function encryptWithDerivedKey(data, derivedKey, iv) {
    const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey, iv);

    const encrypted = Buffer.concat([
        cipher.update(data),
        cipher.final()
    ]);

    const authTag = cipher.getAuthTag();

    // Combine encrypted data and auth tag
    return Buffer.concat([encrypted, authTag]);
}

/**
 * Decrypt data with AES-256-GCM using a derived key
 * @param {Buffer} encryptedData - Encrypted data (includes auth tag)
 * @param {Buffer} derivedKey - 256-bit key derived from password
 * @param {Buffer} iv - 12-byte IV
 * @returns {Buffer} Decrypted data (Kyber secret key)
 */
function decryptWithDerivedKey(encryptedData, derivedKey, iv) {
    // Last 16 bytes are the auth tag
    const authTag = encryptedData.slice(-16);
    const ciphertext = encryptedData.slice(0, -16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final()
    ]);

    return decrypted;
}

export {
    encryptWithDerivedKey,
    decryptWithDerivedKey
};
