import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import AdmZip from 'adm-zip';
import { initializeSchema } from '../database/schemaMigration.js';
import { logRequest } from '../server/requestLogging.js';
import { EventEmitter } from 'node:events';

const root = path.resolve(import.meta.dirname, '..');
const originalSchema = `CREATE TABLE encryption_keys (
    file_id TEXT PRIMARY KEY, public_key BLOB NOT NULL,
    secret_key BLOB NOT NULL, created_at INTEGER NOT NULL
);`;
let workspace, db, statements, processor, png, encryption, wrapping, child;
const progress = () => {};
const passwordKey = crypto.pbkdf2Sync('synthetic test password', Buffer.alloc(32, 7), 600000, 32, 'sha256');
const salt = Buffer.alloc(32, 7).toString('base64');
const iv = Buffer.alloc(12, 9).toString('base64');

before(async () => {
    // Test only copied source and generated data. Never open the working tree's DB.
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'inplainsight-security-'));
    for (const dir of ['server', 'client', 'database']) {
        await fs.mkdir(path.join(workspace, dir));
        for (const name of await fs.readdir(path.join(root, dir))) {
            if (/\.(js|sql|html|css)$/.test(name)) {
                await fs.copyFile(path.join(root, dir, name), path.join(workspace, dir, name));
            }
        }
    }
    await fs.copyFile(path.join(root, 'package.json'), path.join(workspace, 'package.json'));
    await fs.symlink(path.join(root, 'node_modules'), path.join(workspace, 'node_modules'), 'dir');
    for (const dir of ['uploads', 'processed', 'downloads']) await fs.mkdir(path.join(workspace, 'temp', dir), { recursive: true });
    const oldDb = new Database(path.join(workspace, 'database/inplainsight.db'));
    oldDb.exec(originalSchema);
    oldDb.close();
    const load = file => import(pathToFileURL(path.join(workspace, file)).href);
    ({ db, statements } = await load('database/db.js'));
    processor = await load('server/fileProcessor.js');
    png = await load('server/pngEncoder.js');
    encryption = await load('server/encryption.js');
    wrapping = await load('server/serverCrypto.js');
});

after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
        child.kill();
        await once(child, 'exit');
    }
    db?.close();
    if (workspace) await fs.rm(workspace, { recursive: true, force: true });
});

async function fixture({ protectedFile = false, count = 1, id = crypto.randomUUID() } = {}) {
    const { publicKey, secretKey } = encryption.generateKeyPair();
    const content = Buffer.from(`Only synthetic content for ${id}. `.repeat(count * 2));
    const chunks = encryption.splitIntoChunks(content, Math.ceil(content.length / count));
    const wrapped = protectedFile ? wrapping.encryptWithDerivedKey(secretKey, passwordKey, Buffer.from(iv, 'base64')).toString('base64') : null;
    const now = Date.now();
    statements.insertFile.run(id, 'synthetic.txt', content.length, 'text/plain', chunks.length, chunks.length, now, now + 3600000);
    // Historical protected rows intentionally contain both plaintext and wrapped keys.
    statements.insertEncryptionKey.run(id, publicKey, secretKey, now, protectedFile ? 1 : 0, protectedFile ? salt : null, protectedFile ? iv : null, wrapped);
    const paths = [];
    for (const [index, chunk] of chunks.entries()) {
        const { kyberCiphertext, encryptedChunk } = encryption.encryptChunk(chunk, publicKey);
        const size = Buffer.alloc(4); size.writeUInt32BE(kyberCiphertext.length);
        const image = await png.encodeToPNG(Buffer.concat([size, kyberCiphertext, encryptedChunk]), {
            fileId: id, chunkIndex: index, totalChunks: chunks.length, totalPngs: chunks.length,
            passwordProtection: protectedFile ? { enabled: true } : null
        });
        const filename = path.join(workspace, 'temp/uploads', `${id}_${index}.png`);
        await fs.writeFile(filename, image); paths.push(filename);
    }
    return { id, paths, content, secretKey, wrapped };
}

async function mutateHeader(filename, edits) {
    const { data, info } = await sharp(await fs.readFile(filename)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (const [offset, value] of edits) {
        for (let channel = 0; channel < 3; channel++) data[offset * 4 + channel] = value;
    }
    const changed = `${filename}-${crypto.randomUUID()}.png`;
    await fs.writeFile(changed, await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer());
    return changed;
}

async function assertContent(result, content) {
    assert.equal(result.success, true);
    assert.deepEqual(await fs.readFile(result.filePath), content);
}

test('startup upgrades pre-password schemas before preparing queries; migration is additive and repeatable', () => {
    assert.ok(statements.insertEncryptionKey);
    const testDb = new Database(':memory:');
    testDb.exec(originalSchema);
    const historic = Buffer.from('synthetic historical key bytes');
    testDb.prepare('INSERT INTO encryption_keys VALUES (?, ?, ?, ?)').run('legacy', historic, historic, 123);
    initializeSchema(testDb); initializeSchema(testDb);
    const row = testDb.prepare('SELECT * FROM encryption_keys WHERE file_id = ?').get('legacy');
    assert.deepEqual(row.secret_key, historic);
    assert.equal(row.password_protected, 0);
    assert.equal(row.encrypted_secret_key, null);
    assert.equal(testDb.pragma('table_info(encryption_keys)').length, 8);
    testDb.close();
});

test('partial schema upgrades preserve existing password fields without overwriting them', () => {
    const testDb = new Database(':memory:'); testDb.exec(originalSchema);
    testDb.exec('ALTER TABLE encryption_keys ADD COLUMN password_protected INTEGER DEFAULT 0');
    testDb.prepare('INSERT INTO encryption_keys VALUES (?, ?, ?, ?, ?)').run('legacy-protected', Buffer.from('public'), Buffer.from('secret'), 123, 1);
    initializeSchema(testDb); initializeSchema(testDb);
    assert.equal(testDb.prepare('SELECT password_protected FROM encryption_keys').get().password_protected, 1);
    testDb.close();
});

test('historical unprotected PNGs decrypt, including NULL legacy protection state and reordered chunks', async () => {
    const f = await fixture({ count: 3 });
    db.prepare('UPDATE encryption_keys SET password_protected = NULL WHERE file_id = ?').run(f.id);
    await assertContent(await processor.processImagesToFile([...f.paths].reverse(), progress), f.content);
    const flag = await mutateHeader(f.paths[0], [[24, 1]]);
    await assertContent(await processor.processImagesToFile([flag, ...f.paths.slice(1)], progress), f.content);
});

test('historical protected files require authenticated password despite cleared or arbitrary PNG flags', async () => {
    for (const flag of [0, 1, 2, 255]) {
        const f = await fixture({ protectedFile: true });
        const altered = await mutateHeader(f.paths[0], [[24, flag]]);
        const result = await processor.processImagesToFile([altered], progress);
        assert.equal(result.passwordRequired, true);
        assert.equal(result.salt, salt);
        assert.equal(result.iv, iv);
        await assert.rejects(fs.access(path.join(workspace, 'temp/downloads', `${f.id}_reconstructed`)));
        await assert.rejects(processor.processImagesToFile([altered], progress, Buffer.alloc(32, 0)), /Incorrect password/);
        await assertContent(await processor.processImagesToFile([altered], progress, passwordKey), f.content);
        assert.deepEqual(statements.getEncryptionKey.get(f.id).secret_key, f.secretKey);
        assert.equal(statements.getEncryptionKey.get(f.id).encrypted_secret_key, f.wrapped);
    }
});

test('contradictory DB flags remain protected; corrupt or missing wrappers never use historical plaintext', async () => {
    const f = await fixture({ protectedFile: true });
    db.prepare('UPDATE encryption_keys SET password_protected = 0 WHERE file_id = ?').run(f.id);
    assert.equal((await processor.processImagesToFile(f.paths, progress)).passwordRequired, true);
    await assertContent(await processor.processImagesToFile(f.paths, progress, passwordKey), f.content);
    const bytes = Buffer.from(f.wrapped, 'base64'); bytes[bytes.length - 1] ^= 1;
    db.prepare('UPDATE encryption_keys SET encrypted_secret_key = ? WHERE file_id = ?').run(bytes.toString('base64'), f.id);
    await assert.rejects(processor.processImagesToFile(f.paths, progress, passwordKey), /Incorrect password or corrupted/);
    db.prepare('UPDATE encryption_keys SET password_protected = 1, encrypted_secret_key = NULL WHERE file_id = ?').run(f.id);
    await assert.rejects(processor.processImagesToFile(f.paths, progress), /Invalid password protection/);
    assert.deepEqual(statements.getEncryptionKey.get(f.id).secret_key, f.secretKey);
});

test('mixed, duplicate, inconsistent, and out-of-range PNG sets are rejected; missing chunks are reported', async () => {
    const f = await fixture({ protectedFile: true, count: 3 });
    const other = await fixture({ count: 3 });
    await assert.rejects(processor.processImagesToFile([f.paths[0], other.paths[1]], progress), /different files/);
    await assert.rejects(processor.processImagesToFile([f.paths[0], f.paths[0], f.paths[2]], progress), /Duplicate/);
    const outside = await mutateHeader(f.paths[0], [[11, 3]]);
    await assert.rejects(processor.processImagesToFile([outside, ...f.paths.slice(1)], progress), /invalid PNG chunk/);
    const count = await mutateHeader(f.paths[0], [[19, 2]]);
    await assert.rejects(processor.processImagesToFile([count, ...f.paths.slice(1)], progress), /counts/);
    const result = await processor.processImagesToFile(f.paths.slice(1), progress, passwordKey);
    assert.equal(result.missingCount, 1);
    await assertContent(await processor.processImagesToFile([...f.paths].reverse(), progress, passwordKey), f.content);
});

test('mismatched row locator and same-hash collisions cannot select another plaintext key', async () => {
    const a = await fixture({ protectedFile: true }); const b = await fixture();
    const hash = Buffer.alloc(4); hash.writeUInt32BE(png.hashStringTo4Bytes(b.id));
    const swapped = await mutateHeader(a.paths[0], [...hash].map((value, index) => [index + 4, value]));
    await assert.rejects(processor.processImagesToFile([swapped], progress));
    await assert.rejects(fs.access(path.join(workspace, 'temp/downloads', `${b.id}_reconstructed`)));
    const collisionA = await fixture({ id: 'Aa', protectedFile: true });
    await fixture({ id: 'BB' });
    assert.equal(png.hashStringTo4Bytes('Aa'), png.hashStringTo4Bytes('BB'));
    await assert.rejects(processor.processImagesToFile(collisionA.paths, progress), /ambiguous/);
});

test('malformed PNG payload length is rejected before allocating data', async () => {
    const f = await fixture();
    const malformed = await mutateHeader(f.paths[0], [[20, 255], [21, 255], [22, 255], [23, 255]]);
    await assert.rejects(processor.processImagesToFile([malformed], progress), /Truncated data/);
});

test('new protected uploads retain only a wrapped key and still round-trip; invalid input is rejected', async () => {
    const input = path.join(workspace, 'temp/uploads/new-synthetic.txt');
    const content = Buffer.from('Synthetic new protected upload'); await fs.writeFile(input, content);
    await assert.rejects(processor.processFileToImages(input, 'synthetic.txt', 'text/plain', 1, progress, { enabled: true, salt, iv, derivedKey: Buffer.alloc(3) }), /Invalid password/);
    const result = await processor.processFileToImages(input, 'synthetic.txt', 'text/plain', 1, progress, { enabled: true, salt, iv, derivedKey: passwordKey });
    const row = statements.getEncryptionKey.get(result.fileId);
    assert.equal(row.secret_key.length, 0); assert.ok(row.encrypted_secret_key);
    assert.equal((await processor.processImagesToFile(result.pngPaths, progress)).passwordRequired, true);
    await assertContent(await processor.processImagesToFile(result.pngPaths, progress, passwordKey), content);
    const plain = await processor.processFileToImages(input, 'synthetic.txt', 'text/plain', 1, progress);
    assert.ok(statements.getEncryptionKey.get(plain.fileId).secret_key.length);
    await assertContent(await processor.processImagesToFile(plain.pngPaths, progress), content);
});

test('debug filenames and error strings are text nodes, never HTML', async () => {
    const source = await fs.readFile(path.join(root, 'client/app-v2.js'), 'utf8');
    const code = source.slice(source.indexOf('function debugLog('), source.indexOf('// Clear debug button'));
    const node = () => ({ children: [], appendChild(child) { this.children.push(child); }, set innerHTML(_) { throw new Error('unsafe HTML write'); } });
    const output = node();
    const context = vm.createContext({ document: { createElement: node, createTextNode: text => ({ textContent: text }) }, debugOutput: output, console: { log() {} } });
    vm.runInContext(code, context);
    const filename = '<img src=x onerror="globalThis.syntheticExecuted=true">.png';
    context.filename = filename;
    vm.runInContext('debugLog(filename)', context);
    assert.equal(output.children[0].children[1].textContent, filename);
    assert.equal(context.syntheticExecuted, undefined);
});

test('request logger only emits route templates, without bodies, tokens, filenames, or headers', () => {
    const calls = []; const original = console.log;
    console.log = (...args) => calls.push(args);
    try {
        const res = new EventEmitter(); res.statusCode = 200;
        logRequest({ method: 'POST', path: '/secret-token', route: { path: '/api/decode-with-password' }, body: { derivedKey: 'synthetic-key' }, headers: { 'x-private': 'private' } }, res, () => {});
        res.emit('finish');
    } finally { console.log = original; }
    assert.deepEqual(calls, [['Request completed', { method: 'POST', route: '/api/decode-with-password', status: 200 }]]);
});

async function waitForSession(sessionId) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        const response = await fetch(`http://127.0.0.1:3008/api/progress/${sessionId}`);
        const status = await response.json();
        if (['complete', 'password_required', 'error', 'incomplete'].includes(status.stage)) return status;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Synthetic session timed out');
}

async function postImages(endpoint, paths, key) {
    const form = new FormData();
    for (const filename of paths) form.append('files', new Blob([await fs.readFile(filename)], { type: 'image/png' }), 'synthetic.png');
    if (key) form.append('derivedKey', key);
    const response = await fetch(`http://127.0.0.1:3008${endpoint}`, { method: 'POST', body: form });
    assert.equal(response.status, 200);
    return waitForSession((await response.json()).sessionId);
}

test('HTTP endpoints use the same DB gate and never log request keys or attacker-controlled values', async () => {
    let logs = '';
    child = spawn(process.execPath, ['server/server.js'], { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
    const deadline = Date.now() + 10000;
    while (!logs.includes('InPlainSight server running')) {
        if (child.exitCode !== null || Date.now() > deadline) throw new Error('Isolated test server failed to start (port 3008 must be free)');
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    const f = await fixture({ protectedFile: true });
    const cleared = await mutateHeader(f.paths[0], [[24, 0]]);
    assert.equal((await postImages('/api/decode', [cleared])).stage, 'password_required');
    const archive = new AdmZip(); archive.addFile('synthetic-cleared.png', await fs.readFile(cleared));
    async function postZip(endpoint, key) {
        const body = new FormData();
        body.append('files', new Blob([archive.toBuffer()], { type: 'application/zip' }), 'synthetic.zip');
        if (key) body.append('derivedKey', key);
        const response = await fetch(`http://127.0.0.1:3008${endpoint}`, { method: 'POST', body });
        assert.equal(response.status, 200);
        return waitForSession((await response.json()).sessionId);
    }
    assert.equal((await postZip('/api/decode')).stage, 'password_required');
    assert.equal((await postZip('/api/decode-with-password', Buffer.alloc(32).toString('base64'))).stage, 'error');
    assert.equal((await postZip('/api/decode-with-password', passwordKey.toString('base64'))).stage, 'complete');
    assert.equal((await postImages('/api/decode-with-password', [cleared], Buffer.alloc(32).toString('base64'))).stage, 'error');
    const decoded = await postImages('/api/decode-with-password', [cleared], passwordKey.toString('base64'));
    assert.equal(decoded.stage, 'complete');
    const downloaded = await fetch(`http://127.0.0.1:3008/api/download/${decoded.downloadToken}`);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), f.content);

    const sentinel = 'DO-NOT-LOG-SYNTHETIC-FILENAME';
    const form = new FormData(); form.append('file', new Blob(['Synthetic HTTP upload']), `${sentinel}.txt`);
    form.append('passwordProtected', 'true'); form.append('salt', salt); form.append('iv', iv); form.append('derivedKey', passwordKey.toString('base64'));
    const response = await fetch('http://127.0.0.1:3008/api/encode', { method: 'POST', body: form, headers: { 'X-Synthetic': sentinel } });
    assert.equal(response.status, 200);
    const encoded = await waitForSession((await response.json()).sessionId); assert.equal(encoded.stage, 'complete');
    const malformed = await fetch('http://127.0.0.1:3008/api/encode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: `{"derivedKey":"${sentinel}"` });
    assert.equal(malformed.status, 400);
    const invalid = new FormData();
    invalid.append('file', new Blob(['synthetic invalid key upload']), 'invalid.txt');
    invalid.append('passwordProtected', 'true'); invalid.append('derivedKey', 'not base64');
    const invalidResponse = await fetch('http://127.0.0.1:3008/api/encode', { method: 'POST', body: invalid });
    assert.equal(invalidResponse.status, 400);
    await fetch(`http://127.0.0.1:3008/api/file/${sentinel}?derivedKey=${sentinel}`);
    await new Promise(resolve => setTimeout(resolve, 20));
    for (const secret of [sentinel, passwordKey.toString('base64'), salt, iv, decoded.downloadToken]) assert.equal(logs.includes(secret), false, 'logs contain sensitive synthetic value');
    child.kill(); await once(child, 'exit');
});
