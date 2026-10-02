import fs from 'fs';
const fsPromises = fs.promises;
import path from 'path';
import archiver from 'archiver';
import { v4 as uuidv4 } from 'uuid';
import { splitIntoChunks, generateKeyPair, encryptChunk, decryptChunk } from './encryption.js';
import { encodeToPNG, decodeFromPNG, hashStringTo4Bytes } from './pngEncoder.js';
import { statements } from '../database/db.js';
import { fileURLToPath } from 'url';
import { encryptWithDerivedKey } from './serverCrypto.js';
import { decodeBase64, requiresPassword, validateProtectionMetadata, unwrapSecretKey } from './keyProtection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEMP_DIR = path.join(__dirname, '../temp');
const UPLOADS_DIR = path.join(TEMP_DIR, 'uploads');
const PROCESSED_DIR = path.join(TEMP_DIR, 'processed');
const DOWNLOADS_DIR = path.join(TEMP_DIR, 'downloads');

/**
 * Calculate optimal chunk size based on target PNG size
 * @param {number} targetPngSizeMB - Target PNG file size in MB
 * @returns {number} Chunk size in bytes
 */
function calculateChunkSize(targetPngSizeMB) {
    // PNG structure breakdown:
    // - Each data byte becomes 1 pixel in greyscale (stored as RGBA = 4 bytes)
    // - Metadata: 32 pixels = 128 bytes in PNG
    // - Transparent pixel: 1 pixel = 4 bytes
    // - PNG format overhead: ~200 bytes (headers, chunks, etc.)
    //
    // Encryption overhead per chunk:
    // - Kyber ML-KEM-768 ciphertext: 1088 bytes
    // - AES-256-GCM overhead: IV (12) + auth tag (16) = 28 bytes
    // - Length header: 4 bytes
    // - Total encryption overhead: 1088 + 28 + 4 = 1120 bytes
    //
    // Data flow:
    // chunk (N bytes) → encrypt → combined (N + 1120) → PNG encode →
    // pixels (32 + N + 1120 + 1) → RGBA (pixels × 4) → PNG file

    const targetPngBytes = targetPngSizeMB * 1024 * 1024;

    // PNG format overhead (signatures, headers, chunk metadata)
    const pngFormatOverhead = 200;

    // Available bytes for RGBA pixel data
    const availableForPixels = targetPngBytes - pngFormatOverhead;

    // Convert to number of pixels (each pixel = 4 bytes RGBA)
    const maxPixels = Math.floor(availableForPixels / 4);

    // Account for image being square (width × height ≥ needed pixels)
    // Use ~95% to account for rounding up to square dimensions
    const effectivePixels = Math.floor(maxPixels * 0.95);

    // Subtract metadata and transparent pixel
    const dataPixels = effectivePixels - 32 - 1;

    // Subtract encryption overhead (1120 bytes = 1120 pixels in our encoding)
    const chunkSize = dataPixels - 1120;

    // Ensure reasonable bounds (0.5MB to 25MB)
    const minChunk = 0.5 * 1024 * 1024;
    const maxChunk = 25 * 1024 * 1024;

    return Math.max(minChunk, Math.min(chunkSize, maxChunk));
}

/**
 * Process uploaded file: split, encrypt, and generate PNGs
 * @param {string} filePath - Path to uploaded file
 * @param {string} originalFilename - Original filename
 * @param {string} mimeType - MIME type
 * @param {number} targetPngSizeMB - Target PNG file size in MB
 * @param {Function} progressCallback - Callback for progress updates
 * @param {Object} passwordProtection - { enabled, salt, iv, derivedKey } or null
 * @returns {Promise<Object>} { fileId, pngPaths, zipPath }
 */
async function processFileToImages(filePath, originalFilename, mimeType, targetPngSizeMB, progressCallback, passwordProtection = null) {
    if (passwordProtection?.enabled) {
        decodeBase64(passwordProtection.salt, 32);
        decodeBase64(passwordProtection.iv, 12);
        if (!Buffer.isBuffer(passwordProtection.derivedKey) || passwordProtection.derivedKey.length !== 32) {
            throw new Error('Invalid password protection data');
        }
    }
    const fileId = uuidv4();
    const fileData = await fsPromises.readFile(filePath);
    const fileSize = fileData.length;

    progressCallback({ stage: 'splitting', progress: 0 });

    // Calculate chunk size based on target PNG size
    const chunkSize = calculateChunkSize(targetPngSizeMB);
    console.log(`Target PNG size: ${targetPngSizeMB} MB, Calculated chunk size: ${(chunkSize / 1024 / 1024).toFixed(2)} MB`);

    // Split into chunks
    const chunks = splitIntoChunks(fileData, chunkSize);
    const chunkCount = chunks.length;

    progressCallback({ stage: 'encrypting', progress: 0 });

    // Generate Kyber key pair
    const { publicKey, secretKey } = generateKeyPair();

    // Store keys in database
    const now = Date.now();
    const expiresAt = now + (60 * 60 * 1000); // 1 hour

    statements.insertFile.run(
        fileId,
        originalFilename,
        fileSize,
        mimeType,
        chunkCount,
        chunkCount, // PNG count = chunk count (1 PNG per chunk)
        now,
        expiresAt
    );

    // Store encryption keys with password protection info
    const isPasswordProtected = passwordProtection && passwordProtection.enabled ? 1 : 0;
    let salt = null;
    let iv = null;
    let encryptedSecretKeyBase64 = null;

    if (isPasswordProtected) {
        // Encrypt the Kyber secret key with the password-derived key
        salt = passwordProtection.salt;
        iv = passwordProtection.iv;

        const ivBuffer = Buffer.from(iv, 'base64');
        const encryptedSecretKeyBuffer = encryptWithDerivedKey(
            secretKey,
            passwordProtection.derivedKey,
            ivBuffer
        );

        encryptedSecretKeyBase64 = encryptedSecretKeyBuffer.toString('base64');
        console.log('Kyber secret key encrypted with password-derived key');
    }

    statements.insertEncryptionKey.run(
        fileId,
        publicKey,
        // Keep the NOT NULL legacy column without retaining new plaintext protected keys.
        // Historical rows are deliberately left unchanged.
        isPasswordProtected ? Buffer.alloc(0) : secretKey,
        now,
        isPasswordProtected,
        salt,
        iv,
        encryptedSecretKeyBase64
    );

    // Create directory for this file's PNGs
    const fileDir = path.join(PROCESSED_DIR, fileId);
    await fsPromises.mkdir(fileDir, { recursive: true });

    const pngPaths = [];

    // Encrypt each chunk and encode to PNG
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        // Encrypt chunk
        const { kyberCiphertext, encryptedChunk } = encryptChunk(chunk, publicKey);

        // Combine Kyber ciphertext and encrypted data
        const combinedData = Buffer.concat([
            // First 4 bytes: Kyber ciphertext length
            Buffer.from([
                (kyberCiphertext.length >> 24) & 0xFF,
                (kyberCiphertext.length >> 16) & 0xFF,
                (kyberCiphertext.length >> 8) & 0xFF,
                kyberCiphertext.length & 0xFF
            ]),
            kyberCiphertext,
            encryptedChunk
        ]);

        // Encode to PNG with password protection metadata
        const pngBuffer = await encodeToPNG(combinedData, {
            fileId,
            chunkIndex: i,
            totalChunks: chunkCount,
            totalPngs: chunkCount,
            passwordProtection: isPasswordProtected ? {
                enabled: true,
                salt,
                iv,
                encryptedSecretKey: encryptedSecretKeyBase64
            } : null
        });

        // Save PNG
        const pngPath = path.join(fileDir, `${fileId}_${i}.png`);
        await fsPromises.writeFile(pngPath, pngBuffer);
        pngPaths.push(pngPath);

        // Log actual PNG size for first file
        if (i === 0) {
            const actualSizeMB = (pngBuffer.length / 1024 / 1024).toFixed(2);
            console.log(`First PNG actual size: ${actualSizeMB} MB (target: ${targetPngSizeMB} MB)`);
        }

        progressCallback({
            stage: 'generating',
            progress: ((i + 1) / chunks.length) * 100
        });
    }

    // Create ZIP file
    progressCallback({ stage: 'zipping', progress: 0 });
    const zipPath = path.join(DOWNLOADS_DIR, `${fileId}.zip`);
    await createZipFromPngs(pngPaths, zipPath, originalFilename);

    progressCallback({ stage: 'complete', progress: 100 });

    return {
        fileId,
        pngPaths,
        zipPath,
        pngCount: pngPaths.length
    };
}

/**
 * Reconstruct a PNG set, enforcing the database's protection state on every path.
 * PNG metadata is an untrusted locator, never authorization to use plaintext keys.
 * @param {Array<string>} pngPaths
 * @param {Function} progressCallback
 * @param {Buffer|null} derivedKey Password-derived AES key, when supplied
 */
async function processImagesToFile(pngPaths, progressCallback, derivedKey = null) {
    if (!pngPaths.length) throw new Error('No PNG files found');
    progressCallback({ stage: 'reading', progress: 0 });

    const pngData = [];
    for (let i = 0; i < pngPaths.length; i++) {
        pngData.push(await decodeFromPNG(await fsPromises.readFile(pngPaths[i])));
        progressCallback({ stage: 'reading', progress: ((i + 1) / pngPaths.length) * 50 });
    }

    const { fileIdHash, totalPngs, totalChunks } = pngData[0].metadata;
    if (totalPngs < 1 || totalChunks !== totalPngs) throw new Error('Invalid PNG counts');
    const indexes = new Set();
    for (const { metadata } of pngData) {
        if (metadata.fileIdHash !== fileIdHash || metadata.totalPngs !== totalPngs || metadata.totalChunks !== totalChunks) {
            throw new Error('PNGs belong to different files or have inconsistent counts');
        }
        if (metadata.chunkIndex >= totalChunks || indexes.has(metadata.chunkIndex)) {
            throw new Error('Duplicate or invalid PNG chunk index');
        }
        indexes.add(metadata.chunkIndex);
    }

    // Legacy headers contain only a 32-bit hash. Reject ambiguity rather than
    // choosing the first row, especially if colliding rows have different protection.
    const matches = statements.getAllFiles.all().filter(file =>
        file.png_count === totalPngs && file.chunk_count === totalChunks && hashStringTo4Bytes(file.id) === fileIdHash);
    if (matches.length !== 1) throw new Error('File not found or ambiguous PNG file identifier');
    const fileInfo = matches[0];
    const keyData = statements.getEncryptionKey.get(fileInfo.id);
    if (!keyData) throw new Error('Encryption key not found');

    let secretKey;
    if (requiresPassword(keyData)) {
        // Validate the historical wrapper even before prompting. Broken protected
        // records require explicit recovery, never a fallback to their plaintext key.
        validateProtectionMetadata(keyData);
        if (derivedKey === null) {
            return {
                success: false, passwordRequired: true,
                totalCount: totalPngs, uploadedCount: pngPaths.length,
                salt: keyData.salt, iv: keyData.iv
            };
        }
        secretKey = unwrapSecretKey(keyData, derivedKey);
    } else {
        secretKey = keyData.secret_key;
    }

    if (pngPaths.length < totalPngs) {
        return {
            success: false, missingCount: totalPngs - pngPaths.length,
            totalCount: totalPngs, uploadedCount: pngPaths.length
        };
    }

    pngData.sort((a, b) => a.metadata.chunkIndex - b.metadata.chunkIndex);
    progressCallback({ stage: 'decrypting', progress: 50 });
    const decryptedChunks = [];
    for (let i = 0; i < pngData.length; i++) {
        const { data } = pngData[i];
        // ML-KEM-768 ciphertext plus the AES-GCM IV and authentication tag.
        if (data.length < 4 + 1088 + 28 || data.readUInt32BE(0) !== 1088) {
            throw new Error('Invalid encrypted PNG chunk');
        }
        const kyberCiphertext = data.subarray(4, 4 + 1088);
        const encryptedChunk = data.subarray(4 + 1088);
        decryptedChunks.push(decryptChunk(kyberCiphertext, encryptedChunk, secretKey));
        progressCallback({ stage: 'decrypting', progress: 50 + ((i + 1) / pngData.length) * 50 });
    }

    const reconstructedFile = Buffer.concat(decryptedChunks);
    if (reconstructedFile.length !== fileInfo.original_size) throw new Error('Reconstructed file size mismatch');
    const outputPath = path.join(DOWNLOADS_DIR, `${fileInfo.id}_reconstructed`);
    await fsPromises.writeFile(outputPath, reconstructedFile);
    progressCallback({ stage: 'complete', progress: 100 });
    return {
        success: true, filePath: outputPath,
        originalFilename: fileInfo.original_filename, fileId: fileInfo.id
    };
}

/**
 * Create ZIP file from PNG files
 * @param {Array<string>} pngPaths - Array of PNG file paths
 * @param {string} outputPath - Output ZIP file path
 * @param {string} originalFilename - Original filename for better naming
 * @returns {Promise<void>}
 */
function createZipFromPngs(pngPaths, outputPath, originalFilename = 'file') {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outputPath);
        const archive = archiver('zip', { zlib: { level: 0 } }); // No compression

        output.on('close', resolve);
        archive.on('error', reject);

        archive.pipe(output);

        // Create base name from original filename (remove extension)
        const baseName = originalFilename.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9-_]/g, '_');
        const paddedTotal = String(pngPaths.length).length;

        // Add each PNG to the archive with descriptive names
        pngPaths.forEach((pngPath, index) => {
            const paddedIndex = String(index + 1).padStart(paddedTotal, '0');
            archive.file(pngPath, { name: `${baseName}_part${paddedIndex}_of_${pngPaths.length}.png` });
        });

        archive.finalize();
    });
}

export {
    processFileToImages,
    processImagesToFile
};
