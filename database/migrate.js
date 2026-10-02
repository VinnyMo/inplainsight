// Uses the same additive upgrade as normal startup. Back up the database first.
import { db } from './db.js';
console.log('Database schema is up to date');
db.close();
