import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
const fsPromises = fs.promises;
import { v4 as uuidv4 } from 'uuid';
import cors from 'cors';
import AdmZip from 'adm-zip';
import { fileURLToPath } from 'url';

import { processFileToImages, processImagesToFile, processImagesToFileWithKey } from './fileProcessor.js';
import { statements } from '../database/db.js';
import { initCleanupScheduler } from './cleanup.js';
import { encryptWithDerivedKey, decryptWithDerivedKey } from './serverCrypto.js';
import { decodeFromPNG, hashStringTo4Bytes } from './pngEncoder.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Centralized filename sanitization function
function sanitizeFilename(filename) {
    return filename
        .normalize('NFC')
        // Replace all Unicode space characters with regular space
        .replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000]/g, ' ')
        // Fix UTF-8 double-encoding issues (like â¯, â€¯, etc.)
        .replace(/â¯/g, ' ')
        .replace(/â€¯/g, ' ')
        .replace(/â /g, ' ')
        // Remove any other problematic characters
        .replace(/[^\x20-\x7E\u00A0-\uFFFF]/g, '');
}

const app = express();
const PORT = 3008;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client')));

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, path.join(__dirname, '../temp/uploads'));
    },
    filename: (req, file, cb) => {
        cb(null, `${uuidv4()}_${file.originalname}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 * 1024 } // 10GB limit
});

// Log all incoming requests for debugging
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.path} - Content-Length: ${req.headers['content-length'] || 'unknown'}`);
    next();
});

// Store active processing sessions for progress tracking
const processSessions = new Map();

/**
 * POST /api/encode
 * Upload a file and encode it into PNGs
 */
app.post('/api/encode', (req, res, next) => {
    console.log('=== /api/encode ENDPOINT HIT ===');
    console.log('Content-Type:', req.headers['content-type']);
    console.log('Content-Length:', req.headers['content-length']);

    // Pass to multer
    const uploadHandler = upload.single('file');
    uploadHandler(req, res, (err) => {
        if (err) {
            console.error('MULTER ERROR:', err);
            return res.status(500).json({ error: `Upload error: ${err.message}` });
        }
        next();
    });
}, async (req, res) => {
    console.log('=== MULTER PROCESSING COMPLETE ===');

    if (!req.file) {
        console.log('ERROR: No file in req.file');
        return res.status(400).json({ error: 'No file uploaded' });
    }

    const sessionId = uuidv4();
    const filePath = req.file.path;
    const originalFilename = sanitizeFilename(req.file.originalname);
    const mimeType = req.file.mimetype;
    const targetPngSizeMB = parseInt(req.body.targetPngSizeMB) || 10;

    // Password protection info (sent from client after PBKDF2 derivation)
    let passwordProtection = null;
    let derivedKeyBuffer = null;
    if (req.body.passwordProtected === 'true') {
        // Client sends: salt, iv, and the derived key itself
        // Server will encrypt the Kyber secret key with this derived key
        const salt = req.body.salt;
        const iv = req.body.iv;
        const derivedKeyBase64 = req.body.derivedKey;

        // Convert base64 derived key to buffer
        derivedKeyBuffer = Buffer.from(derivedKeyBase64, 'base64');

        passwordProtection = {
            enabled: true,
            salt: salt,
            iv: iv,
            derivedKey: derivedKeyBuffer
        };
    }

    console.log('=== ENCODE REQUEST ===');
    console.log('File received:', originalFilename);
    console.log('File size:', req.file.size);
    console.log('File path:', filePath);
    console.log('Password protected:', passwordProtection ? 'YES' : 'NO');
    console.log('req.body:', req.body);
    console.log('targetPngSizeMB from body:', req.body.targetPngSizeMB);
    console.log('Parsed targetPngSizeMB:', targetPngSizeMB);

    // Create progress tracking
    processSessions.set(sessionId, {
        stage: 'starting',
        progress: 0
    });

    // Send session ID immediately
    res.json({ sessionId });

    // Process file asynchronously
    try {
        const result = await processFileToImages(
            filePath,
            originalFilename,
            mimeType,
            targetPngSizeMB,
            (progress) => {
                processSessions.set(sessionId, progress);
            },
            passwordProtection
        );

        // Create download token for ZIP
        const token = uuidv4();
        const now = Date.now();
        statements.insertDownloadToken.run(
            token,
            result.fileId,
            'zip',
            now,
            now + (60 * 60 * 1000) // 1 hour
        );

        // Update session with completion data
        processSessions.set(sessionId, {
            stage: 'complete',
            progress: 100,
            fileId: result.fileId,
            pngCount: result.pngCount,
            downloadToken: token
        });

        // Clean up uploaded file
        await fsPromises.unlink(filePath);
    } catch (err) {
        console.error('Error processing file:', err);
        processSessions.set(sessionId, {
            stage: 'error',
            error: err.message
        });

        // Clean up on error
        try {
            await fsPromises.unlink(filePath);
        } catch {}
    }
});

/**
 * GET /api/progress/:sessionId
 * Get progress of encoding/decoding operation
 */
app.get('/api/progress/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const progress = processSessions.get(sessionId);

    if (!progress) {
        return res.status(404).json({ error: 'Session not found' });
    }

    res.json(progress);
});

/**
 * POST /api/decode-with-password
 * Decode password-protected PNGs with derived key from client
 */
app.post('/api/decode-with-password', upload.any(), async (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
    }

    const sessionId = uuidv4();
    const derivedKeyBase64 = req.body.derivedKey;

    if (!derivedKeyBase64) {
        return res.status(400).json({ error: 'No derived key provided' });
    }

    console.log('=== DECODE WITH PASSWORD REQUEST ===');
    console.log('Files:', req.files.length);
    console.log('Derived key provided');

    // Create progress tracking
    processSessions.set(sessionId, {
        stage: 'starting',
        progress: 0
    });

    // Send session ID immediately
    res.json({ sessionId });

    // Process files asynchronously
    try {
        let pngPaths = [];

        // Check if uploaded file is a ZIP
        if (req.files.length === 1 && req.files[0].originalname.endsWith('.zip')) {
            // Extract ZIP
            const zipPath = req.files[0].path;
            const extractDir = path.join(__dirname, '../temp/uploads', uuidv4());
            await fsPromises.mkdir(extractDir, { recursive: true });

            const zip = new AdmZip(zipPath);
            zip.extractAllTo(extractDir, true);

            // Get all PNG files from extracted directory
            const files = await fsPromises.readdir(extractDir);
            pngPaths = files
                .filter(f => f.endsWith('.png'))
                .map(f => path.join(extractDir, f));

            // Clean up ZIP
            await fsPromises.unlink(zipPath);
        } else {
            // Individual PNG files
            pngPaths = req.files.map(f => f.path);
        }

        // Decode PNGs and get password protection info
        const firstPng = await fsPromises.readFile(pngPaths[0]);
        const { metadata } = await decodeFromPNG(firstPng);

        if (!metadata.passwordProtected) {
            processSessions.set(sessionId, {
                stage: 'error',
                error: 'These PNGs are not password protected'
            });
            return;
        }

        // Get file info from database to get encrypted secret key
        const allFiles = statements.getAllFiles.all();
        const fileInfo = allFiles.find(f => {
            const computedHash = hashStringTo4Bytes(f.id);
            return f.png_count === metadata.totalPngs && computedHash === metadata.fileIdHash;
        });

        if (!fileInfo) {
            processSessions.set(sessionId, {
                stage: 'error',
                error: 'File not found in database'
            });
            return;
        }

        // Get encryption key data
        const keyData = statements.getEncryptionKey.get(fileInfo.id);
        if (!keyData || !keyData.encrypted_secret_key) {
            processSessions.set(sessionId, {
                stage: 'error',
                error: 'Encryption key not found'
            });
            return;
        }

        // Decrypt the Kyber secret key using the derived key from client
        const derivedKeyBuffer = Buffer.from(derivedKeyBase64, 'base64');
        const saltBuffer = Buffer.from(keyData.salt, 'base64');
        const ivBuffer = Buffer.from(keyData.iv, 'base64');
        const encryptedSecretKeyBuffer = Buffer.from(keyData.encrypted_secret_key, 'base64');

        let decryptedSecretKey;
        try {
            decryptedSecretKey = decryptWithDerivedKey(
                encryptedSecretKeyBuffer,
                derivedKeyBuffer,
                ivBuffer
            );
            console.log('Kyber secret key decrypted successfully');
        } catch (err) {
            console.error('Failed to decrypt secret key - wrong password?', err);
            processSessions.set(sessionId, {
                stage: 'error',
                error: 'Incorrect password'
            });

            // Clean up uploaded files
            for (const pngPath of pngPaths) {
                try {
                    await fsPromises.unlink(pngPath);
                } catch {}
            }
            return;
        }

        // Now proceed with normal decryption using the decrypted secret key
        const result = await processImagesToFileWithKey(
            pngPaths,
            decryptedSecretKey,
            (progress) => {
                processSessions.set(sessionId, progress);
            }
        );

        if (!result.success) {
            processSessions.set(sessionId, {
                stage: 'incomplete',
                missingCount: result.missingCount,
                totalCount: result.totalCount,
                uploadedCount: result.uploadedCount
            });
        } else {
            // Create download token
            const token = uuidv4();
            const now = Date.now();
            statements.insertDownloadToken.run(
                token,
                result.fileId,
                'original',
                now,
                now + (60 * 60 * 1000)
            );

            processSessions.set(sessionId, {
                stage: 'complete',
                progress: 100,
                originalFilename: sanitizeFilename(result.originalFilename),
                downloadToken: token
            });
        }

        // Clean up uploaded files
        for (const pngPath of pngPaths) {
            try {
                await fsPromises.unlink(pngPath);
            } catch {}
        }
    } catch (err) {
        console.error('Error decoding files with password:', err);
        processSessions.set(sessionId, {
            stage: 'error',
            error: err.message
        });

        // Clean up on error
        for (const file of req.files) {
            try {
                await fsPromises.unlink(file.path);
            } catch {}
        }
    }
});

/**
 * POST /api/decode
 * Upload PNGs (individual or ZIP) and decode back to original file
 */
app.post('/api/decode', upload.any(), async (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
    }

    const sessionId = uuidv4();

    // Create progress tracking
    processSessions.set(sessionId, {
        stage: 'starting',
        progress: 0
    });

    // Send session ID immediately
    res.json({ sessionId });

    // Process files asynchronously
    try {
        let pngPaths = [];

        // Check if uploaded file is a ZIP
        if (req.files.length === 1 && req.files[0].originalname.endsWith('.zip')) {
            // Extract ZIP
            const zipPath = req.files[0].path;
            const extractDir = path.join(__dirname, '../temp/uploads', uuidv4());
            await fsPromises.mkdir(extractDir, { recursive: true });

            const zip = new AdmZip(zipPath);
            zip.extractAllTo(extractDir, true);

            // Get all PNG files from extracted directory
            const files = await fsPromises.readdir(extractDir);
            pngPaths = files
                .filter(f => f.endsWith('.png'))
                .map(f => path.join(extractDir, f));

            // Clean up ZIP
            await fsPromises.unlink(zipPath);
        } else {
            // Individual PNG files
            pngPaths = req.files.map(f => f.path);
        }

        const result = await processImagesToFile(
            pngPaths,
            (progress) => {
                processSessions.set(sessionId, progress);
            }
        );

        if (!result.success) {
            if (result.passwordRequired) {
                // Password-protected PNGs detected
                processSessions.set(sessionId, {
                    stage: 'password_required',
                    passwordRequired: true,
                    totalCount: result.totalCount,
                    uploadedCount: result.uploadedCount,
                    salt: result.salt,
                    iv: result.iv
                });
            } else {
                // Missing PNGs
                processSessions.set(sessionId, {
                    stage: 'incomplete',
                    missingCount: result.missingCount,
                    totalCount: result.totalCount,
                    uploadedCount: result.uploadedCount
                });
            }
        } else {
            // Create download token
            const token = uuidv4();
            const now = Date.now();
            statements.insertDownloadToken.run(
                token,
                result.fileId,
                'original',
                now,
                now + (60 * 60 * 1000)
            );

            processSessions.set(sessionId, {
                stage: 'complete',
                progress: 100,
                originalFilename: sanitizeFilename(result.originalFilename),
                downloadToken: token
            });
        }

        // Clean up uploaded files
        for (const pngPath of pngPaths) {
            try {
                await fsPromises.unlink(pngPath);
            } catch {}
        }
    } catch (err) {
        console.error('Error decoding files:', err);
        processSessions.set(sessionId, {
            stage: 'error',
            error: err.message
        });

        // Clean up on error
        for (const file of req.files) {
            try {
                await fsPromises.unlink(file.path);
            } catch {}
        }
    }
});

/**
 * GET /api/download/:token
 * Download file using temporary token
 */
app.get('/api/download/:token', async (req, res) => {
    const { token } = req.params;
    const now = Date.now();

    const tokenData = statements.getDownloadToken.get(token, now);

    if (!tokenData) {
        return res.status(404).json({ error: 'Invalid or expired download link' });
    }

    const fileData = statements.getFile.get(tokenData.file_id);

    if (!fileData) {
        return res.status(404).json({ error: 'File not found' });
    }

    try {
        // Encode filename for download header
        const encodeFilenameForDownload = (filename) => {
            const sanitized = sanitizeFilename(filename);
            return encodeURIComponent(sanitized).replace(/['()]/g, escape).replace(/\*/g, '%2A');
        };

        if (tokenData.file_type === 'zip') {
            // Download ZIP of PNGs
            const zipPath = path.join(__dirname, '../temp/downloads', `${fileData.id}.zip`);
            // Create descriptive ZIP filename
            const baseName = fileData.original_filename.replace(/\.[^/.]+$/, '');
            const downloadName = encodeFilenameForDownload(`${baseName}_encrypted.zip`);
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${downloadName}`);
            res.sendFile(zipPath);
        } else {
            // Download reconstructed original file
            const filePath = path.join(__dirname, '../temp/downloads', `${fileData.id}_reconstructed`);
            // Add suffix to indicate it's been reconstructed/decrypted
            const filenameParts = fileData.original_filename.match(/^(.+?)(\.[^.]+)?$/);
            const baseName = filenameParts[1] || fileData.original_filename;
            const extension = filenameParts[2] || '';
            const reconstructedName = `${baseName}_decrypted${extension}`;
            const downloadName = encodeFilenameForDownload(reconstructedName);
            res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${downloadName}`);
            res.sendFile(filePath);
        }
    } catch (err) {
        console.error('Error downloading file:', err);
        res.status(500).json({ error: 'Error downloading file' });
    }
});

/**
 * GET /api/png/:fileId/:index
 * Download individual PNG by file ID and index
 */
app.get('/api/png/:fileId/:index', async (req, res) => {
    const { fileId, index } = req.params;

    const fileData = statements.getFile.get(fileId);

    if (!fileData) {
        return res.status(404).json({ error: 'File not found' });
    }

    const pngPath = path.join(__dirname, '../temp/processed', fileId, `${fileId}_${index}.png`);

    try {
        await fsPromises.access(pngPath);
        res.sendFile(pngPath);
    } catch {
        res.status(404).json({ error: 'PNG not found' });
    }
});

/**
 * GET /api/file/:fileId
 * Get file metadata
 */
app.get('/api/file/:fileId', (req, res) => {
    const { fileId } = req.params;
    const fileData = statements.getFile.get(fileId);

    if (!fileData) {
        return res.status(404).json({ error: 'File not found' });
    }

    // Get encryption key info to check password protection
    const keyData = statements.getEncryptionKey.get(fileId);
    const passwordProtected = keyData && keyData.password_protected === 1;

    res.json({
        id: fileData.id,
        originalFilename: sanitizeFilename(fileData.original_filename),
        originalSize: fileData.original_size,
        pngCount: fileData.png_count,
        expiresAt: fileData.expires_at,
        passwordProtected: passwordProtected,
        ...(passwordProtected && {
            salt: keyData.salt,
            iv: keyData.iv,
            encryptedSecretKey: keyData.encrypted_secret_key
        })
    });
});

// Initialize cleanup scheduler
initCleanupScheduler();

// Start server
const server = app.listen(PORT, '127.0.0.1', () => {
    console.log(`InPlainSight server running on port ${PORT}`);
    console.log(`Access at: http://localhost:${PORT}`);
});

// Set timeout to 2 hours for large file uploads
// Default is 2 minutes which is too short for 1GB+ files
server.timeout = 2 * 60 * 60 * 1000; // 2 hours in milliseconds
server.keepAliveTimeout = 65000; // Slightly higher than nginx default
server.headersTimeout = 66000; // Should be higher than keepAliveTimeout
