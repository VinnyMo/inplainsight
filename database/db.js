import Database from 'better-sqlite3';
import { initializeSchema } from './schemaMigration.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, 'inplainsight.db');

// Initialize database
const db = new Database(dbPath);

// Enable WAL mode for better concurrent access
db.pragma('journal_mode = WAL');

// Ensure UTF-8 encoding
db.pragma('encoding = "UTF-8"');

// Upgrade old schemas before preparing statements against newer columns.
initializeSchema(db);

// Prepared statements for common operations
const statements = {
    insertFile: db.prepare(`
        INSERT INTO files (id, original_filename, original_size, mime_type, chunk_count, png_count, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),

    insertEncryptionKey: db.prepare(`
        INSERT INTO encryption_keys (file_id, public_key, secret_key, created_at, password_protected, salt, iv, encrypted_secret_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),

    insertDownloadToken: db.prepare(`
        INSERT INTO download_tokens (token, file_id, file_type, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?)
    `),

    getFile: db.prepare('SELECT * FROM files WHERE id = ?'),

    getAllFiles: db.prepare('SELECT * FROM files'),

    getEncryptionKey: db.prepare('SELECT * FROM encryption_keys WHERE file_id = ?'),

    getDownloadToken: db.prepare('SELECT * FROM download_tokens WHERE token = ? AND expires_at > ?'),

    deleteExpiredFiles: db.prepare('DELETE FROM files WHERE expires_at < ?'),

    deleteExpiredTokens: db.prepare('DELETE FROM download_tokens WHERE expires_at < ?'),

    deleteFile: db.prepare('DELETE FROM files WHERE id = ?'),
};

export {
    db,
    statements
};

