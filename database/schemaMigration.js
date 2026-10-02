import fs from 'node:fs';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const passwordColumns = [
    ['password_protected', 'INTEGER DEFAULT 0'],
    ['salt', 'TEXT'],
    ['iv', 'TEXT'],
    ['encrypted_secret_key', 'TEXT']
];

// Additive, idempotent, and atomic. Never rewrite or remove historical keys.
// Must run before preparing statements that reference the added columns.
export function initializeSchema(db) {
    db.transaction(() => {
        db.exec(schema);
        const columns = new Set(db.pragma('table_info(encryption_keys)').map(column => column.name));
        for (const [name, definition] of passwordColumns) {
            if (!columns.has(name)) {
                db.exec(`ALTER TABLE encryption_keys ADD COLUMN ${name} ${definition}`);
            }
        }
    })();
}
