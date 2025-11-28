import fs from 'fs';
const fsPromises = fs.promises;
import path from 'path';
import archiver from 'archiver';
import { v4 as uuidv4 } from 'uuid';
import { splitIntoChunks, generateKeyPair, encryptChunk, decryptChunk } from './encryption.js';
import { encodeToPNG, decodeFromPNG, hashStringTo4Bytes } from './pngEncoder.js';
import { statements } from '../database/db.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEMP_DIR = path.join(__dirname, '../temp');
const UPLOADS_DIR = path.join(TEMP_DIR, 'uploads');
const PROCESSED_DIR = path.join(TEMP_DIR, 'processed');
const DOWNLOADS_DIR = path.join(TEMP_DIR, 'downloads');

/**
 * Process uploaded file: split, encrypt, and generate PNGs
 * @param {string} filePath - Path to uploaded file
 * @param {string} originalFilename - Original filename
 * @param {string} mimeType - MIME type
 * @param {Function} progressCallback - Callback for progress updates
 * @returns {Promise<Object>} { fileId, pngPaths, zipPath }
 */
async function processFileToImages(filePath, originalFilename, mimeType, progressCallback) {
    const fileId = uuidv4();
    const fileData = await fsPromises.readFile(filePath);
    const fileSize = fileData.length;

    progressCallback({ stage: 'splitting', progress: 0 });

    // Split into chunks
    const chunks = splitIntoChunks(fileData);
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

    statements.insertEncryptionKey.run(
        fileId,
        publicKey,
        secretKey,
        now
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

        // Encode to PNG
        const pngBuffer = await encodeToPNG(combinedData, {
            fileId,
            chunkIndex: i,
            totalChunks: chunkCount,
            totalPngs: chunkCount
        });

        // Save PNG
        const pngPath = path.join(fileDir, `${fileId}_${i}.png`);
        await fsPromises.writeFile(pngPath, pngBuffer);
        pngPaths.push(pngPath);

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

export {
    processFileToImages,
    processImagesToFile
};
