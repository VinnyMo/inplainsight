-- InPlainSight Database Schema
-- Stores encryption keys and file metadata

CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    original_filename TEXT NOT NULL,
    original_size INTEGER NOT NULL,
    mime_type TEXT,
    chunk_count INTEGER NOT NULL,
    png_count INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS encryption_keys (
    file_id TEXT PRIMARY KEY,
    public_key BLOB NOT NULL,
    secret_key BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    password_protected INTEGER DEFAULT 0,
    salt TEXT,
    iv TEXT,
    encrypted_secret_key TEXT,
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS download_tokens (
    token TEXT PRIMARY KEY,
    file_id TEXT NOT NULL,
    file_type TEXT NOT NULL, -- 'zip' or 'original'
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_files_expires_at ON files(expires_at);
CREATE INDEX IF NOT EXISTS idx_download_tokens_expires_at ON download_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_download_tokens_token ON download_tokens(token);
