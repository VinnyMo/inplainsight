/**
 * Client-side cryptography utilities for password-based encryption
 * All encryption happens in the browser - passwords never sent to server
 */

/**
 * Derive a cryptographic key from a password using PBKDF2
 * @param {string} password - User's password
 * @param {Uint8Array} salt - Random salt (32 bytes)
 * @param {number} iterations - Number of PBKDF2 iterations (default: 600000)
 * @returns {Promise<CryptoKey>} Derived AES-GCM key
 */
async function deriveKeyFromPassword(password, salt, iterations = 600000) {
    const enc = new TextEncoder();
    const passwordBuffer = enc.encode(password);

    // Import password as a key
    const passwordKey = await window.crypto.subtle.importKey(
        'raw',
        passwordBuffer,
        'PBKDF2',
        false,
        ['deriveKey']
    );

    // Derive AES-GCM key from password
    const derivedKey = await window.crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: salt,
            iterations: iterations,
            hash: 'SHA-256'
        },
        passwordKey,
        {
            name: 'AES-GCM',
            length: 256
        },
        true, // Must be extractable so we can export it to send to server
        ['encrypt', 'decrypt']
    );

    return derivedKey;
}

/**
 * Encrypt data (Kyber secret key) with password-derived key
 * @param {Uint8Array} data - Data to encrypt (Kyber secret key)
 * @param {string} password - User's password
 * @returns {Promise<Object>} {encryptedData, salt, iv, authTag}
 */
async function encryptWithPassword(data, password) {
    // Generate random salt (32 bytes)
    const salt = window.crypto.getRandomValues(new Uint8Array(32));

    // Derive key from password
    const key = await deriveKeyFromPassword(password, salt);

    // Generate random IV (12 bytes for AES-GCM)
    const iv = window.crypto.getRandomValues(new Uint8Array(12));

    // Encrypt data
    const encryptedData = await window.crypto.subtle.encrypt(
        {
            name: 'AES-GCM',
            iv: iv,
            tagLength: 128 // 128-bit authentication tag
        },
        key,
        data
    );

    // encryptedData contains ciphertext + auth tag (last 16 bytes)
    const encryptedArray = new Uint8Array(encryptedData);

    return {
        encryptedData: encryptedArray,
        salt: salt,
        iv: iv
    };
}

/**
 * Decrypt data with password-derived key
 * @param {Uint8Array} encryptedData - Encrypted data (includes auth tag)
 * @param {Uint8Array} salt - Salt used for key derivation
 * @param {Uint8Array} iv - IV used for encryption
 * @param {string} password - User's password
 * @returns {Promise<Uint8Array>} Decrypted data (Kyber secret key)
 */
async function decryptWithPassword(encryptedData, salt, iv, password) {
    // Derive key from password
    const key = await deriveKeyFromPassword(password, salt);

    // Decrypt data
    try {
        const decryptedData = await window.crypto.subtle.decrypt(
            {
                name: 'AES-GCM',
                iv: iv,
                tagLength: 128
            },
            key,
            encryptedData
        );

        return new Uint8Array(decryptedData);
    } catch (err) {
        throw new Error('Incorrect password or corrupted data');
    }
}

/**
 * Convert Uint8Array to base64 string
 * @param {Uint8Array} buffer
 * @returns {string}
 */
function arrayToBase64(buffer) {
    let binary = '';
    const len = buffer.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(buffer[i]);
    }
    return window.btoa(binary);
}

/**
 * Convert base64 string to Uint8Array
 * @param {string} base64
 * @returns {Uint8Array}
 */
function base64ToArray(base64) {
    const binary = window.atob(base64);
    const len = binary.length;
    const buffer = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        buffer[i] = binary.charCodeAt(i);
    }
    return buffer;
}

// Export functions
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        encryptWithPassword,
        decryptWithPassword,
        arrayToBase64,
        base64ToArray
    };
}
