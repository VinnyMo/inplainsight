import { decryptWithDerivedKey } from './serverCrypto.js';

export function decodeBase64(value, expectedLength) {
    if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        throw new Error('Invalid password protection data');
    }
    const bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64') !== value || (expectedLength !== undefined && bytes.length !== expectedLength)) {
        throw new Error('Invalid password protection data');
    }
    return bytes;
}

export function requiresPassword(keyData) {
    // Old, genuinely unprotected rows have 0 (or NULL) and no wrapper fields.
    // Any contradictory/unknown protection state must never select plaintext.
    return (keyData.password_protected !== 0 && keyData.password_protected !== null)
        || ['salt', 'iv', 'encrypted_secret_key'].some(field => keyData[field] !== null && keyData[field] !== undefined);
}

export function validateProtectionMetadata(keyData) {
    decodeBase64(keyData.salt, 32);
    const iv = decodeBase64(keyData.iv, 12);
    const wrappedKey = decodeBase64(keyData.encrypted_secret_key);
    if (wrappedKey.length <= 16) throw new Error('Invalid password protection data');
    return { iv, wrappedKey };
}

export function unwrapSecretKey(keyData, derivedKey) {
    const { iv, wrappedKey } = validateProtectionMetadata(keyData);
    if (!Buffer.isBuffer(derivedKey) || derivedKey.length !== 32) {
        throw new Error('Invalid password protection data');
    }
    try {
        // AES-GCM final() verifies the authentication tag before returning bytes.
        return decryptWithDerivedKey(wrappedKey, derivedKey, iv);
    } catch {
        throw new Error('Incorrect password or corrupted protection data');
    }
}
