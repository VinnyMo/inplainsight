import sharp from 'sharp';

/**
 * Encode encrypted data into a PNG image
 *
 * Strategy:
 * - Each byte of data is encoded as a greyscale pixel value (0-255)
 * - Metadata is encoded in the first row of pixels
 * - One transparent pixel is added to prevent compression
 * - Remaining pixels contain the actual encrypted data
 *
 * Metadata format (first 32 pixels):
 * - Pixels 0-3: Magic number "INPS" (73, 78, 80, 83)
 * - Pixels 4-7: File ID (4 bytes as uint32)
 * - Pixels 8-11: Chunk index (4 bytes as uint32)
 * - Pixels 12-15: Total chunks (4 bytes as uint32)
 * - Pixels 16-19: Total PNG count (4 bytes as uint32)
 * - Pixels 20-23: Data length in this PNG (4 bytes as uint32)
 * - Pixels 24-31: Reserved for future use
 */

const METADATA_PIXELS = 32;
const MAGIC_NUMBER = Buffer.from('INPS', 'ascii');

/**
 * Encode data and metadata into a PNG
 * @param {Buffer} data - The encrypted data to encode
 * @param {Object} metadata - { fileId, chunkIndex, totalChunks, totalPngs, passwordProtection }
 * @returns {Promise<Buffer>} PNG image buffer
 */
async function encodeToPNG(data, metadata) {
    const { fileId, chunkIndex, totalChunks, totalPngs, passwordProtection } = metadata;

    // Calculate image dimensions
    // Total pixels = metadata + data + 1 transparent pixel
    const totalPixels = METADATA_PIXELS + data.length + 1;
    const width = Math.ceil(Math.sqrt(totalPixels));
    const height = Math.ceil(totalPixels / width);

    // Create RGBA buffer (4 channels per pixel)
    const imageBuffer = Buffer.alloc(width * height * 4);

    let pixelIndex = 0;

    // Write metadata pixels (all opaque, greyscale)
    const metadataBuffer = Buffer.alloc(METADATA_PIXELS);

    // Magic number
    MAGIC_NUMBER.copy(metadataBuffer, 0);

    // File ID hash (convert string to 4-byte hash)
    const fileIdHash = hashStringTo4Bytes(fileId);
    metadataBuffer.writeUInt32BE(fileIdHash, 4);

    // Chunk index
    metadataBuffer.writeUInt32BE(chunkIndex, 8);

    // Total chunks
    metadataBuffer.writeUInt32BE(totalChunks, 12);

    // Total PNGs
    metadataBuffer.writeUInt32BE(totalPngs, 16);

    // Data length
    metadataBuffer.writeUInt32BE(data.length, 20);

    // Password protected flag (byte 24)
    if (passwordProtection && passwordProtection.enabled) {
        metadataBuffer[24] = 1;
    } else {
        metadataBuffer[24] = 0;
    }

    // Write metadata to image
    for (let i = 0; i < METADATA_PIXELS; i++) {
        const offset = pixelIndex * 4;
        const value = metadataBuffer[i];
        imageBuffer[offset] = value;     // R
        imageBuffer[offset + 1] = value; // G
        imageBuffer[offset + 2] = value; // B
        imageBuffer[offset + 3] = 255;   // A (opaque)
        pixelIndex++;
    }

    // Write data pixels (greyscale, opaque)
    for (let i = 0; i < data.length; i++) {
        const offset = pixelIndex * 4;
        const value = data[i];
        imageBuffer[offset] = value;     // R
        imageBuffer[offset + 1] = value; // G
        imageBuffer[offset + 2] = value; // B
        imageBuffer[offset + 3] = 255;   // A (opaque)
        pixelIndex++;
    }

    // Add one transparent pixel to prevent compression
    const offset = pixelIndex * 4;
    imageBuffer[offset] = 0;     // R
    imageBuffer[offset + 1] = 0; // G
    imageBuffer[offset + 2] = 0; // B
    imageBuffer[offset + 3] = 0; // A (transparent)
    pixelIndex++;

    // Fill remaining pixels with black, opaque
    while (pixelIndex < width * height) {
        const offset = pixelIndex * 4;
        imageBuffer[offset] = 0;     // R
        imageBuffer[offset + 1] = 0; // G
        imageBuffer[offset + 2] = 0; // B
        imageBuffer[offset + 3] = 255; // A (opaque)
        pixelIndex++;
    }

    // Create PNG using Sharp
    const pngBuffer = await sharp(imageBuffer, {
        raw: {
            width,
            height,
            channels: 4
        }
    })
    .png({
        compressionLevel: 0, // No compression to preserve data
        palette: false
    })
    .toBuffer();

    return pngBuffer;
}

/**
 * Decode PNG back to encrypted data and metadata
 * @param {Buffer} pngBuffer - The PNG image buffer
 * @returns {Promise<Object>} { data, metadata }
 */
async function decodeFromPNG(pngBuffer) {
    // Extract raw pixel data
    const { data: pixelData, info } = await sharp(pngBuffer)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    if (info.channels !== 4 || pixelData.length < METADATA_PIXELS * 4) {
        throw new Error('Invalid PNG: Incomplete metadata');
    }

    // Extract metadata from first 32 pixels
    const metadataBuffer = Buffer.alloc(METADATA_PIXELS);
    for (let i = 0; i < METADATA_PIXELS; i++) {
        // Read R channel (all channels are the same for greyscale)
        metadataBuffer[i] = pixelData[i * 4];
    }

    // Verify magic number
    const magic = metadataBuffer.slice(0, 4).toString('ascii');
    if (magic !== 'INPS') {
        throw new Error('Invalid PNG: Magic number not found');
    }

    // Parse metadata
    const fileIdHash = metadataBuffer.readUInt32BE(4);
    const chunkIndex = metadataBuffer.readUInt32BE(8);
    const totalChunks = metadataBuffer.readUInt32BE(12);
    const totalPngs = metadataBuffer.readUInt32BE(16);
    const dataLength = metadataBuffer.readUInt32BE(20);
    const passwordProtected = metadataBuffer[24] === 1;

    if (dataLength > Math.floor(pixelData.length / 4) - METADATA_PIXELS - 1) {
        throw new Error('Invalid PNG: Truncated data');
    }

    // Extract data pixels
    const data = Buffer.alloc(dataLength);
    for (let i = 0; i < dataLength; i++) {
        // Read R channel from pixel after metadata
        data[i] = pixelData[(METADATA_PIXELS + i) * 4];
    }

    return {
        data,
        metadata: {
            fileIdHash,
            chunkIndex,
            totalChunks,
            totalPngs,
            dataLength,
            passwordProtected
        }
    };
}

/**
 * Hash a string to a 4-byte integer (for file ID comparison)
 * @param {string} str - String to hash
 * @returns {number} 32-bit hash
 */
function hashStringTo4Bytes(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash = hash & 0xFFFFFFFF; // Convert to 32-bit integer
    }
    return Math.abs(hash);
}

export {
    encodeToPNG,
    decodeFromPNG,
    hashStringTo4Bytes
};

