import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, 'inplainsight.db');

console.log('Running database migration...');

const db = new Database(dbPath);

// Check if columns exist
const tableInfo = db.pragma('table_info(encryption_keys)');
const columnNames = tableInfo.map(col => col.name);

const columnsToAdd = [
    { name: 'password_protected', definition: 'INTEGER DEFAULT 0' },
    { name: 'salt', definition: 'TEXT' },
    { name: 'iv', definition: 'TEXT' },
    { name: 'encrypted_secret_key', definition: 'TEXT' }
];

let migrated = false;
for (const column of columnsToAdd) {
    if (!columnNames.includes(column.name)) {
        console.log(`Adding column: ${column.name}`);
        db.exec(`ALTER TABLE encryption_keys ADD COLUMN ${column.name} ${column.definition}`);
        migrated = true;
    } else {
        console.log(`Column ${column.name} already exists`);
    }
}

if (migrated) {
    console.log('Migration completed successfully!');
} else {
    console.log('No migration needed - database is up to date');
}

db.close();
