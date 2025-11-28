import schedule from 'node-schedule';
import fs from 'fs';
const fsPromises = fs.promises;
import path from 'path';
import { db, statements } from '../database/db.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEMP_DIR = path.join(__dirname, '../temp');
const PROCESSED_DIR = path.join(TEMP_DIR, 'processed');
const UPLOADS_DIR = path.join(TEMP_DIR, 'uploads');
const DOWNLOADS_DIR = path.join(TEMP_DIR, 'downloads');

/**
 * Clean up expired files and database entries
 */
async function cleanupExpiredFiles() {
    const now = Date.now();

    console.log('[Cleanup] Starting cleanup of expired files...');

    // Get expired files from database
    const expiredFiles = db.prepare('SELECT * FROM files WHERE expires_at < ?').all(now);

    console.log(`[Cleanup] Found ${expiredFiles.length} expired files`);

    // Delete file directories
    for (const file of expiredFiles) {
        const fileDir = path.join(PROCESSED_DIR, file.id);
        try {
            await fsPromises.rm(fileDir, { recursive: true, force: true });
            console.log(`[Cleanup] Deleted directory: ${fileDir}`);
        } catch (err) {
            console.error(`[Cleanup] Error deleting directory ${fileDir}:`, err.message);
        }

        // Delete ZIP file
        const zipPath = path.join(DOWNLOADS_DIR, `${file.id}.zip`);
        try {
            await fsPromises.unlink(zipPath);
            console.log(`[Cleanup] Deleted ZIP: ${zipPath}`);
        } catch (err) {
            // File might not exist
        }

        // Delete reconstructed file
        const reconstructedPath = path.join(DOWNLOADS_DIR, `${file.id}_reconstructed`);
        try {
            await fsPromises.unlink(reconstructedPath);
            console.log(`[Cleanup] Deleted reconstructed file: ${reconstructedPath}`);
        } catch (err) {
            // File might not exist
        }
    }

    // Delete from database
    statements.deleteExpiredFiles.run(now);
    statements.deleteExpiredTokens.run(now);

    // Clean up orphaned files in uploads directory
    try {
        const uploadFiles = await fsPromises.readdir(UPLOADS_DIR);
        for (const file of uploadFiles) {
            const filePath = path.join(UPLOADS_DIR, file);
            const stats = await fsPromises.stat(filePath);
            const fileAge = now - stats.mtimeMs;

            // Delete files older than 2 hours
            if (fileAge > 2 * 60 * 60 * 1000) {
                await fsPromises.unlink(filePath);
                console.log(`[Cleanup] Deleted old upload: ${filePath}`);
            }
        }
    } catch (err) {
        console.error('[Cleanup] Error cleaning uploads directory:', err.message);
    }

    console.log('[Cleanup] Cleanup complete');
}

/**
 * Initialize cleanup scheduler
 * Runs every 15 minutes
 */
function initCleanupScheduler() {
    // Run cleanup every 15 minutes
    schedule.scheduleJob('*/15 * * * *', async () => {
        try {
            await cleanupExpiredFiles();
        } catch (err) {
            console.error('[Cleanup] Error during scheduled cleanup:', err);
        }
    });

    console.log('[Cleanup] Scheduler initialized - running every 15 minutes');

    // Run initial cleanup on startup
    setTimeout(async () => {
        try {
            await cleanupExpiredFiles();
        } catch (err) {
            console.error('[Cleanup] Error during initial cleanup:', err);
        }
    }, 5000); // Wait 5 seconds after startup
}

export {
    initCleanupScheduler,
    cleanupExpiredFiles
};
