import fs from 'fs';
const fsPromises = fs.promises;
import path from 'path';
import archiver from 'archiver';
import { v4 as uuidv4 } from 'uuid';
import { splitIntoChunks, generateKeyPair, encryptChunk, decryptChunk } from './encryption.js';
import { encodeToPNG, decodeFromPNG, hashStringTo4Bytes } from './pngEncoder.js';
import { statements } from '../database/db.js';
import { fileURLToPath } from 'url';
import { encryptWithDerivedKey, decryptWithDerivedKey } from './serverCrypto.js';

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
 * @param {Object} passwordProtection - { enabled, salt, iv, encryptedSecretKey } or null
 * @returns {Promise<Object>} { fileId, pngPaths, zipPath }
 */
async function processFileToImages(filePath, originalFilename, mimeType, targetPngSizeMB, progressCallback, passwordProtection = null) {
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
        secretKey,
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
 * Process uploaded PNGs to reconstruct original file
 * @param {Array<string>} pngPaths - Paths to uploaded PNG files
 * @param {Function} progressCallback - Callback for progress updates
 * @returns {Promise<Object>} { success, filePath, originalFilename, missingCount }
 */
async function processImagesToFile(pngPaths, progressCallback) {
    progressCallback({ stage: 'reading', progress: 0 });

    // Decode all PNGs
    const pngData = [];
    for (let i = 0; i < pngPaths.length; i++) {
        const pngBuffer = await fsPromises.readFile(pngPaths[i]);
        const decoded = await decodeFromPNG(pngBuffer);
        pngData.push(decoded);

        progressCallback({
            stage: 'reading',
            progress: ((i + 1) / pngPaths.length) * 50
        });
    }

    // Check if any PNG is password protected
    const isPasswordProtected = pngData.some(png => png.metadata.passwordProtected);

    if (isPasswordProtected) {
        console.log('Password-protected PNGs detected');

        // Get file info to return salt and IV
        const fileIdHash = pngData[0].metadata.fileIdHash;
        const allFiles = statements.getAllFiles.all();
        const fileInfo = allFiles.find(f => {
            const computedHash = hashStringTo4Bytes(f.id);
            return f.png_count === pngData[0].metadata.totalPngs && computedHash === fileIdHash;
        });

        let salt = null;
        let iv = null;

        if (fileInfo) {
            const keyData = statements.getEncryptionKey.get(fileInfo.id);
            if (keyData) {
                salt = keyData.salt;
                iv = keyData.iv;
            }
        }

        // Return early with password required status and salt/IV
        return {
            success: false,
            passwordRequired: true,
            totalCount: pngData[0].metadata.totalPngs,
            uploadedCount: pngPaths.length,
            salt: salt,
            iv: iv
        };
    }

    // Validate all PNGs belong to same file
    const fileIdHashes = [...new Set(pngData.map(d => d.metadata.fileIdHash))];
    if (fileIdHashes.length > 1) {
        throw new Error('PNGs belong to different files');
    }

    const totalPngs = pngData[0].metadata.totalPngs;
    const uploadedPngs = pngPaths.length;

    if (uploadedPngs < totalPngs) {
        return {
            success: false,
            missingCount: totalPngs - uploadedPngs,
            totalCount: totalPngs,
            uploadedCount: uploadedPngs
        };
    }

    progressCallback({ stage: 'decrypting', progress: 50 });

    // Sort by chunk index
    pngData.sort((a, b) => a.metadata.chunkIndex - b.metadata.chunkIndex);

    // Get file info from database
    // Match by PNG count and verify file ID hash
    const allFiles = statements.getAllFiles.all();
    const fileIdHash = pngData[0].metadata.fileIdHash;

    const fileInfo = allFiles.find(f => {
        const computedHash = hashStringTo4Bytes(f.id);
        return f.png_count === totalPngs && computedHash === fileIdHash;
    });

    if (!fileInfo) {
        throw new Error(`File not found in database (PNG count: ${totalPngs}, uploaded: ${uploadedPngs}, hash: ${fileIdHash})`);
    }

    // Get encryption key
    const keyData = statements.getEncryptionKey.get(fileInfo.id);
    if (!keyData) {
        throw new Error('Encryption key not found');
    }

    const secretKey = keyData.secret_key;

    // Decrypt all chunks
    const decryptedChunks = [];
    for (let i = 0; i < pngData.length; i++) {
        const { data } = pngData[i];

        // Extract Kyber ciphertext length
        const kyberCiphertextLength = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];

        // Extract Kyber ciphertext and encrypted chunk
        const kyberCiphertext = data.slice(4, 4 + kyberCiphertextLength);
        const encryptedChunk = data.slice(4 + kyberCiphertextLength);

        // Decrypt
        const decryptedChunk = decryptChunk(kyberCiphertext, encryptedChunk, secretKey);
        decryptedChunks.push(decryptedChunk);

        progressCallback({
            stage: 'decrypting',
            progress: 50 + ((i + 1) / pngData.length) * 50
        });
    }

    // Combine chunks
    const reconstructedFile = Buffer.concat(decryptedChunks);

    // Save reconstructed file
    const outputPath = path.join(DOWNLOADS_DIR, `${fileInfo.id}_reconstructed`);
    await fsPromises.writeFile(outputPath, reconstructedFile);

    progressCallback({ stage: 'complete', progress: 100 });

    return {
        success: true,
        filePath: outputPath,
        originalFilename: fileInfo.original_filename,
        fileId: fileInfo.id
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

/**
 * Process uploaded PNGs to reconstruct original file (with provided secret key)
 * Used for password-protected files where secret key is decrypted on server
 * @param {Array<string>} pngPaths - Paths to uploaded PNG files
 * @param {Buffer} secretKey - Decrypted Kyber secret key
 * @param {Function} progressCallback - Callback for progress updates
 * @returns {Promise<Object>} { success, filePath, originalFilename }
 */
async function processImagesToFileWithKey(pngPaths, secretKey, progressCallback) {
    progressCallback({ stage: 'reading', progress: 0 });

    // Decode all PNGs
    const pngData = [];
    for (let i = 0; i < pngPaths.length; i++) {
        const pngBuffer = await fsPromises.readFile(pngPaths[i]);
        const decoded = await decodeFromPNG(pngBuffer);
        pngData.push(decoded);

        progressCallback({
            stage: 'reading',
            progress: ((i + 1) / pngPaths.length) * 50
        });
    }

    // Validate all PNGs belong to same file
    const fileIdHashes = [...new Set(pngData.map(d => d.metadata.fileIdHash))];
    if (fileIdHashes.length > 1) {
        throw new Error('PNGs belong to different files');
    }

    const totalPngs = pngData[0].metadata.totalPngs;
    const uploadedPngs = pngPaths.length;

    if (uploadedPngs < totalPngs) {
        return {
            success: false,
            missingCount: totalPngs - uploadedPngs,
            totalCount: totalPngs,
            uploadedCount: uploadedPngs
        };
    }

    progressCallback({ stage: 'decrypting', progress: 50 });

    // Sort by chunk index
    pngData.sort((a, b) => a.metadata.chunkIndex - b.metadata.chunkIndex);

    // Get file info from database
    const allFiles = statements.getAllFiles.all();
    const fileIdHash = pngData[0].metadata.fileIdHash;

    const fileInfo = allFiles.find(f => {
        const computedHash = hashStringTo4Bytes(f.id);
        return f.png_count === totalPngs && computedHash === fileIdHash;
    });

    if (!fileInfo) {
        throw new Error(`File not found in database (PNG count: ${totalPngs}, uploaded: ${uploadedPngs}, hash: ${fileIdHash})`);
    }

    // Decrypt all chunks using the provided secret key
    const decryptedChunks = [];
    for (let i = 0; i < pngData.length; i++) {
        const { data } = pngData[i];

        // Extract Kyber ciphertext length
        const kyberCiphertextLength = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];

        // Extract Kyber ciphertext and encrypted chunk
        const kyberCiphertext = data.slice(4, 4 + kyberCiphertextLength);
        const encryptedChunk = data.slice(4 + kyberCiphertextLength);

        // Decrypt using provided secret key
        const decryptedChunk = decryptChunk(kyberCiphertext, encryptedChunk, secretKey);
        decryptedChunks.push(decryptedChunk);

        progressCallback({
            stage: 'decrypting',
            progress: 50 + ((i + 1) / pngData.length) * 50
        });
    }

    // Combine chunks
    const reconstructedFile = Buffer.concat(decryptedChunks);

    // Save reconstructed file
    const outputPath = path.join(DOWNLOADS_DIR, `${fileInfo.id}_reconstructed`);
    await fsPromises.writeFile(outputPath, reconstructedFile);

    progressCallback({ stage: 'complete', progress: 100 });

    return {
        success: true,
        filePath: outputPath,
        originalFilename: fileInfo.original_filename,
        fileId: fileInfo.id
    };
}

export {
    processFileToImages,
    processImagesToFile,
    processImagesToFileWithKey
};
