/**
 * Dependency-free execution of the real frontend event handlers in a small DOM
 * model. This supplements, not replaces, Chromium layout/accessibility tests.
 * All files, XHR requests, fetch responses, timers, and history are synthetic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto, pbkdf2Sync } from 'node:crypto';

const client = path.resolve(import.meta.dirname, '../client');
const [html, appSource, cryptoSource] = await Promise.all(['index.html', 'app-v2.js', 'crypto-utils.js'].map(name => fs.readFile(path.join(client, name), 'utf8')));
const salt = Buffer.alloc(32, 7).toString('base64');
const completeEncode = { stage: 'complete', progress: 100, fileId: 'synthetic-file', pngCount: 2, downloadToken: 'synthetic-token' };
const completeDecode = { stage: 'complete', progress: 100, originalFilename: 'synthetic.txt', downloadToken: 'synthetic-download' };
const passwordRequired = { stage: 'password_required', passwordRequired: true, salt, iv: Buffer.alloc(12, 9).toString('base64') };
const file = (name = 'synthetic.txt', content = 'Synthetic content only') => new File([content], name);
const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(check, message = 'Expected asynchronous workflow state') {
    const deadline = Date.now() + 5000;
    while (!check()) {
        if (Date.now() > deadline) assert.fail(message);
        await turn();
    }
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function response(data, status = 200) { return { status, ok: status >= 200 && status < 300, json: async () => data }; }

class Element {
    constructor(tag = 'div', document) {
        this.tagName = tag.toUpperCase(); this.ownerDocument = document;
        this.children = []; this.parentNode = null; this.attributes = new Map();
        this.dataset = {}; this.listeners = new Map(); this.hidden = false;
        this.disabled = false; this.value = ''; this.type = ''; this.files = [];
        this.open = false; this.className = ''; this._text = '';
        this.classList = {
            contains: value => this.className.split(/\s+/).includes(value),
            add: value => { if (!this.classList.contains(value)) this.className = `${this.className} ${value}`.trim(); },
            remove: value => { this.className = this.className.split(/\s+/).filter(item => item !== value).join(' '); },
            toggle: (value, enabled) => { (enabled ?? !this.classList.contains(value)) ? this.classList.add(value) : this.classList.remove(value); }
        };
    }
    get href() { return this.attributes.get('href') ?? ''; }
    set href(value) { this.attributes.set('href', String(value)); }
    set innerHTML(_) { throw new Error('Unsafe HTML write in the frontend'); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.children = []; }
    get firstElementChild() { return this.children.find(child => child.tagName !== '#TEXT'); }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    replaceChildren(...children) { this.children = []; this._text = ''; this.append(...children); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); }
    setAttribute(name, value) {
        value = String(value); this.attributes.set(name, value);
        if (name === 'class') this.className = value;
        if (name === 'hidden') this.hidden = true;
        if (name === 'value' || name === 'type') this[name] = value;
        if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); if (name === 'value') this.value = ''; }
    addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
    emit(type, properties = {}) {
        const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...properties };
        for (const listener of this.listeners.get(type) ?? []) listener(event);
        return event;
    }
    click() { if (!this.disabled) this.emit('click'); }
    focus() { this.ownerDocument.activeElement = this; }
    select() { this.focus(); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    querySelectorAll(selector) {
        const all = [];
        const walk = element => { for (const child of element.children) { all.push(child); walk(child); } };
        walk(this);
        const ancestor = (element, predicate) => { for (let parent = element.parentNode; parent; parent = parent.parentNode) if (predicate(parent)) return true; return false; };
        if (selector === '.steps li') return all.filter(element => element.tagName === 'LI' && ancestor(element, parent => parent.classList.contains('steps')));
        if (selector === '.view:not([hidden]) h2') return all.filter(element => element.tagName === 'H2' && ancestor(element, parent => parent.classList.contains('view') && !parent.hidden));
        if (selector === '[data-reveal]') return all.filter(element => element.dataset.reveal);
        const reveal = selector.match(/^\[data-reveal="([^"]+)"\]$/);
        if (reveal) return all.filter(element => element.dataset.reveal === reveal[1]);
        throw new Error(`Unsupported fixture selector: ${selector}`);
    }
}

function documentFixture() {
    const document = { activeElement: null, ids: new Map() };
    document.createElement = tag => new Element(tag, document);
    document.createTextNode = text => { const node = new Element('#text', document); node.textContent = text; return node; };
    document.root = document.createElement('document');
    const stack = [document.root];
    const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
    for (const token of html.matchAll(/<\/?([a-z][\w:-]*)\b([^>]*?)\/?\s*>|([^<]+)/gi)) {
        if (!token[1]) { stack.at(-1).appendChild(document.createTextNode(token[3] ?? '')); continue; }
        const tag = token[1].toLowerCase();
        if (token[0].startsWith('</')) { while (stack.length > 1 && stack.pop().tagName !== tag.toUpperCase()) {} continue; }
        const element = document.createElement(tag);
        for (const attr of token[2].matchAll(/([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) element.setAttribute(attr[1], attr[2] ?? attr[3] ?? attr[4] ?? '');
        const id = element.getAttribute('id'); if (id) document.ids.set(id, element);
        stack.at(-1).appendChild(element);
        if (!voidTags.has(tag)) stack.push(element);
    }
    document.getElementById = id => { const found = document.ids.get(id); if (!found) throw new Error(`Missing actual HTML ID: ${id}`); return found; };
    document.querySelector = selector => document.root.querySelector(selector);
    document.querySelectorAll = selector => document.root.querySelectorAll(selector);
    return document;
}

function harness({ search = '', hash = '' } = {}) {
    const document = documentFixture();
    const timers = new Map(), uploads = [], fetches = [], routes = new Map(), logs = [], pendingCrypto = new Set();
    let timerId = 0, now = 0;
    const window = new Element('window', document);
    const location = new URL(`https://synthetic.invalid/inplainsight/${search}${hash}`);
    window.location = location; window.btoa = btoa; window.atob = atob;
    window.crypto = {
        getRandomValues: value => webcrypto.getRandomValues(value),
        subtle: new Proxy(webcrypto.subtle, { get(target, key) {
            if (typeof target[key] !== 'function') return target[key];
            return (...args) => {
                const promise = target[key](...args); pendingCrypto.add(promise);
                promise.then(() => pendingCrypto.delete(promise), () => pendingCrypto.delete(promise));
                return promise;
            };
        } })
    };
    window.history = {
        replaceState(_state, _title, url) { location.href = new URL(url, location).href; },
        pushState(_state, _title, url) { location.href = new URL(url, location).href; }
    };
    class XHR extends Element {
        constructor() { super('xhr', document); delete this.open; this.upload = new Element('upload', document); this.status = 0; this.responseText = ''; this.aborted = false; }
        open(method, url) { this.method = method; this.url = url; }
        send(form) { this.form = form; uploads.push(this); }
        abort() { this.aborted = true; this.emit('abort'); }
        reply(data, status = 200, raw = false) { this.status = status; this.responseText = raw ? data : JSON.stringify(data); this.emit('load'); }
    }
    const context = vm.createContext({
        document, window, navigator: { clipboard: { writeText: async () => {} } },
        console: { log: (...values) => logs.push(values.join(' ')) },
        URL, URLSearchParams, Uint8Array, TextEncoder, FormData, AbortController, Date, JSON,
        XMLHttpRequest: XHR,
        setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
        fetch(url, options) {
            fetches.push({ url, options });
            const handler = routes.get(url);
            if (!handler) return Promise.reject(new Error(`No synthetic response for ${url}`));
            return typeof handler === 'function' ? handler(url, options) : Promise.resolve(handler);
        }
    });
    routes.set('/inplainsight/api/file/synthetic-file', response({ expiresAt: Date.now() + 3600000 }));
    // Resume routes must be registered before evaluating the real startup code.
    let loaded = false;
    const api = {
        document, window, uploads, fetches, logs, timers,
        async settleCrypto() { await turn(); while (pendingCrypto.size) { await Promise.allSettled([...pendingCrypto]); await turn(); } },
        metadata(value, status = 200) { routes.set('/inplainsight/api/file/synthetic-file', typeof value === 'function' ? value : response(value, status)); },
        el: id => document.getElementById(id),
        read: expression => vm.runInContext(expression, context),
        load() { if (loaded) return; loaded = true; vm.runInContext(cryptoSource, context, { filename: 'crypto-utils.js' }); vm.runInContext(appSource, context, { filename: 'app-v2.js' }); },
        route(session, value, status = 200) { routes.set(`/inplainsight/api/progress/${session}`, typeof value === 'function' ? value : response(value, status)); return api; },
        choose(mode, files) { const input = api.el(`${mode}-file-input`); input.files = Array.isArray(files) ? files : [files]; input.emit('change'); },
        click(id) { api.el(id).click(); },
        submit(id) { api.el(id).emit('submit'); },
        async advance(milliseconds = 750) {
            now += milliseconds;
            for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
            for (let i = 0; i < 5; i++) await turn();
        },
        view(mode) { return api.read(`jobs.${mode}.view`); }
    };
    return api;
}

// These tests execute the production functions only through their registered UI
// events, apart from inspecting state for assertions and synthetic time control.
test('UI state: selection, Back, invalid files, and reset remain local', () => {
    const h = harness(); h.load(); h.choose('encode', file());
    assert.equal(h.view('encode'), 'review'); assert.equal(h.el('encode-selection').textContent, 'synthetic.txt');
    h.el('encode-password').value = 'synthetic preference'; h.el('png-size-slider').value = '5'; h.click('encode-back');
    assert.equal(h.view('encode'), 'choose'); assert.equal(h.read('jobs.encode.files.length'), 1);
    h.choose('encode', []); assert.equal(h.read('jobs.encode.files.length'), 1);
    h.click('encode-keep'); assert.equal(h.view('encode'), 'review'); h.click('encode-back');
    h.choose('encode', file('empty.txt', '')); assert.match(h.el('encode-error').textContent, /empty/i);
    const large = file('large.bin'); Object.defineProperty(large, 'size', { value: 10 * 1024 ** 3 + 1 });
    h.choose('encode', large); assert.match(h.el('encode-error').textContent, /10 GB/);
    h.choose('encode', [file('one.txt'), file('two.txt')]); assert.match(h.el('encode-error').textContent, /one file/i);
    for (const files of [[file('wrong.txt')], [file('one.zip'), file('one.png')], [file('one.zip'), file('two.zip')], [file('empty.png', '')]]) {
        h.choose('decode', files); assert.equal(h.el('decode-error').hidden, false); assert.equal(h.read('jobs.decode.files.length'), 0);
    }
    assert.equal(h.uploads.length, 0); assert.equal(h.fetches.length, 0);
    assert.equal(h.el('encode-password').value, 'synthetic preference'); assert.equal(h.el('png-size-slider').value, '5');
    h.click('encode-reset'); assert.equal(h.read('jobs.encode.files.length'), 0); assert.equal(h.el('encode-password').value, ''); assert.equal(h.el('png-size-slider').value, '10');
});

test('UI state: drag/drop selection and keyboard tab history use the actual handlers', () => {
    const h = harness(); h.load();
    const drop = h.el('encode-drop-zone'); drop.emit('dragover'); assert.equal(drop.classList.contains('drag-over'), true);
    drop.emit('drop', { dataTransfer: { files: [file()] } }); assert.equal(drop.classList.contains('drag-over'), false);
    assert.equal(h.view('encode'), 'review'); assert.equal(h.uploads.length, 0);
    h.el('hide-tab').emit('keydown', { key: 'ArrowRight' }); assert.equal(h.el('recover-tab').getAttribute('aria-selected'), 'true');
    assert.equal(h.document.activeElement, h.el('recover-tab')); assert.equal(h.window.location.hash, '#recover');
    h.el('recover-tab').emit('keydown', { key: 'Home' }); assert.equal(h.el('hide-tab').getAttribute('aria-selected'), 'true'); assert.equal(h.view('encode'), 'review');
    h.window.location.hash = '#recover'; h.window.emit('popstate'); assert.equal(h.el('decode-panel').hidden, false);
});

test('UI state: explicit Start uploads once, reflects real progress, and finishes', async () => {
    const h = harness(); h.route('encode', { stage: 'generating', progress: 42 }); h.load(); h.choose('encode', file());
    h.el('png-size-slider').value = '5'; h.submit('encode-form'); h.submit('encode-form');
    assert.equal(h.uploads.length, 1, h.el('encode-error').textContent); assert.equal(h.view('encode'), 'progress');
    const upload = h.uploads[0]; assert.equal(upload.form.get('targetPngSizeMB'), '5');
    upload.upload.emit('progress', { lengthComputable: true, loaded: 1, total: 4 }); assert.equal(h.el('encode-progress-bar').value, 25);
    upload.reply({ sessionId: 'encode' }); await until(() => h.el('encode-progress-bar').value === 42);
    h.route('encode', completeEncode); await h.advance();
    assert.equal(h.view('encode'), 'result'); assert.match(h.el('download-zip').href, /api\/download\/synthetic-token$/);
    assert.equal(h.fetches.some(entry => entry.url.includes('/api/download/')), false);
    h.el('png-details').open = true; h.el('png-details').emit('toggle'); assert.equal(h.el('png-gallery').children.length, 2);
    assert.equal(h.logs.length, 0);
});

test('UI state: pending upload and late poll cannot overwrite a reset or newer selection', async () => {
    const h = harness(); h.load(); h.choose('encode', file()); h.submit('encode-form');
    const oldUpload = h.uploads[0]; h.click('encode-reset'); assert.equal(oldUpload.aborted, true);
    oldUpload.reply({ sessionId: 'stale-upload' }); assert.equal(h.fetches.length, 0); assert.equal(h.view('encode'), 'choose');
    const pending = deferred(); h.route('stale-poll', () => pending.promise);
    h.choose('encode', file('second.txt')); h.submit('encode-form'); h.uploads[1].reply({ sessionId: 'stale-poll' });
    await until(() => h.fetches.length === 1); h.click('encode-reset'); h.choose('encode', file('newest.txt'));
    pending.resolve(response(completeEncode)); await turn(); await turn();
    assert.equal(h.view('encode'), 'review'); assert.equal(h.el('encode-selection').textContent, 'newest.txt'); assert.equal(h.el('encode-result').hidden, true);
});

test('UI state: Hide and Recover preserve independent jobs across tabs and resets', async () => {
    const h = harness(); h.route('encoding', { stage: 'encrypting', progress: 10 }); h.route('decoding', completeDecode); h.load();
    h.choose('encode', file()); h.submit('encode-form'); h.uploads[0].reply({ sessionId: 'encoding' }); await turn();
    h.click('recover-tab'); h.choose('decode', [file('one.png'), file('two.png')]); h.submit('decode-form'); h.uploads[1].reply({ sessionId: 'decoding' });
    await until(() => h.view('decode') === 'result'); h.click('hide-tab'); assert.equal(h.view('encode'), 'progress');
    h.click('encode-reset'); h.click('recover-tab'); assert.equal(h.view('decode'), 'result'); assert.equal(h.el('download-original').href, '/inplainsight/api/download/synthetic-download');
});

test('UI state: ZIP normalization and multipart PNG selection preserve file bytes', () => {
    const h = harness(); h.load(); h.choose('decode', file('BUNDLE.ZIP')); h.submit('decode-form');
    assert.equal(h.uploads[0].form.get('files').name, 'BUNDLE.zip');
    h.click('decode-reset'); h.choose('decode', [file('PART_1.PNG'), file('part_2.png')]); h.submit('decode-form');
    assert.deepEqual(h.uploads[1].form.getAll('files').map(entry => entry.name), ['PART_1.PNG', 'part_2.png']);
});

test('UI state: wrong password retries retain all files and derive the protocol key', async () => {
    const h = harness(); h.route('protected', passwordRequired); h.route('wrong', { stage: 'error', error: 'Incorrect password' }); h.route('right', completeDecode); h.load();
    h.click('recover-tab'); h.choose('decode', [file('part_1.png'), file('part_2.png')]); h.submit('decode-form'); h.uploads[0].reply({ sessionId: 'protected' });
    await until(() => h.view('decode') === 'password');
    for (const [index, password, session] of [[1, 'synthetic wrong', 'wrong'], [2, 'synthetic correct', 'right']]) {
        h.el('decode-password').value = password; h.submit('password-form'); h.submit('password-form');
        await until(() => h.uploads.length === index + 1);
        const upload = h.uploads[index]; assert.equal(upload.url, '/inplainsight/api/decode-with-password');
        assert.equal(upload.form.getAll('files').length, 2);
        assert.equal(upload.form.get('derivedKey'), pbkdf2Sync(password, Buffer.from(salt, 'base64'), 600000, 32, 'sha256').toString('base64'));
        assert.equal([...upload.form.values()].includes(password), false); assert.equal(h.el('decode-password').value, '');
        upload.reply({ sessionId: session }); await until(() => h.view('decode') === (index === 1 ? 'password' : 'result'));
        if (index === 1) assert.match(h.el('password-error').textContent, /password|try again/i);
    }
    assert.equal(h.uploads.length, 3);
});

test('UI state: password Back and Escape preserve selected files without another upload', async () => {
    const h = harness(); h.route('password-back', passwordRequired); h.load(); h.click('recover-tab'); h.choose('decode', file('bundle.zip')); h.submit('decode-form');
    h.uploads[0].reply({ sessionId: 'password-back' }); await until(() => h.view('decode') === 'password');
    h.el('decode-password').value = 'discard me'; h.el('password-panel').emit('keydown', { key: 'Escape' });
    assert.equal(h.view('decode'), 'review'); assert.equal(h.el('decode-password').value, ''); assert.equal(h.read('jobs.decode.files.length'), 1); assert.equal(h.uploads.length, 1);
    h.submit('decode-form'); h.uploads[1].reply({ sessionId: 'password-back' }); await until(() => h.view('decode') === 'password'); h.click('password-back'); assert.equal(h.view('decode'), 'review');
});

test('UI state: protected encode keeps protection through retries and ignores stale crypto completion', async () => {
    const h = harness(); h.load(); h.choose('encode', file()); h.el('encode-password').value = 'synthetic password';
    h.submit('encode-form'); h.submit('encode-form'); await until(() => h.uploads.length === 1);
    const form = h.uploads[0].form;
    assert.equal(form.get('passwordProtected'), 'true'); assert.equal(Buffer.from(form.get('salt'), 'base64').length, 32); assert.equal(Buffer.from(form.get('iv'), 'base64').length, 12);
    assert.equal(form.get('derivedKey'), pbkdf2Sync('synthetic password', Buffer.from(form.get('salt'), 'base64'), 600000, 32, 'sha256').toString('base64'));
    assert.equal(h.el('encode-password').value, 'synthetic password');
    h.uploads[0].reply({}, 500); assert.equal(h.view('encode'), 'review');
    h.submit('encode-form'); await until(() => h.uploads.length === 2);
    assert.equal(h.uploads[1].form.get('passwordProtected'), 'true');
    h.uploads[1].emit('error'); h.submit('encode-form'); await until(() => h.uploads.length === 3);
    assert.equal(h.uploads[2].form.get('passwordProtected'), 'true');
    h.click('encode-reset'); assert.equal(h.el('encode-password').value, ''); h.choose('encode', file('new.txt')); h.el('encode-password').value = 'synthetic delayed'; h.submit('encode-form'); h.click('encode-reset');
    await h.settleCrypto();
    assert.equal(h.uploads.length, 3); assert.equal(h.view('encode'), 'choose');
});

test('UI state: failed upload, malformed response, and incomplete bundle recover inline', async () => {
    for (const [body, status, raw] of [[{}, 200, false], ['{broken', 200, true], [{ error: 'failure' }, 500, false], [{ error: 'too large' }, 413, false]]) {
        const h = harness(); h.load(); h.choose('encode', file()); h.submit('encode-form'); h.uploads[0].reply(body, status, raw);
        assert.equal(h.el('encode-error').hidden, false); assert.equal(h.view('encode'), 'review'); assert.equal(h.fetches.length, 0);
    }
    const h = harness(); h.route('incomplete', { stage: 'incomplete', missingCount: 2, totalCount: 3, uploadedCount: 1 }); h.load(); h.choose('decode', file('one.png')); h.submit('decode-form');
    h.uploads[0].reply({ sessionId: 'incomplete' }); await until(() => !h.el('decode-error').hidden); assert.match(h.el('decode-error').textContent, /2 images are missing/); assert.equal(h.view('decode'), 'review');
});

test('UI state: failed and malformed status checks stop, then retry without upload', async () => {
    for (const initial of [() => Promise.reject(new Error('synthetic offline')), {}, { stage: 'unknown' }, { stage: 'complete', progress: 100 }, null]) {
        const h = harness(); h.route('retry', initial); h.load(); h.choose('encode', file()); h.submit('encode-form'); h.uploads[0].reply({ sessionId: 'retry' });
        await until(() => !h.el('encode-retry').hidden); assert.equal(h.view('encode'), 'progress'); assert.equal(h.el('encode-result').hidden, true);
        const fetchCount = h.fetches.length; await h.advance(5000); assert.equal(h.fetches.length, fetchCount);
        h.route('retry', completeEncode); h.click('encode-retry'); await until(() => h.view('encode') === 'result'); assert.equal(h.uploads.length, 1);
    }
});

test('UI state: session resume, 404 expiry, and invalid links never trigger upload', async () => {
    const h = harness({ search: '?session=resume' }); h.route('resume', completeEncode); h.load(); await until(() => h.view('encode') === 'result'); assert.equal(h.uploads.length, 0);
    const expired = harness({ search: '?session=expired' }); expired.route('expired', { error: 'Session not found' }, 404); expired.load(); await until(() => !expired.el('encode-error').hidden);
    assert.match(expired.el('encode-error').textContent, /expired|no longer/); assert.equal(expired.el('encode-return').hidden, true); assert.equal(expired.window.location.search, ''); assert.equal(expired.uploads.length, 0);
    const invalid = harness({ search: `?session=${'x'.repeat(201)}` }); invalid.load(); assert.match(invalid.el('encode-error').textContent, /invalid/i); assert.equal(invalid.fetches.length, 0);
});

test('UI state: filenames stay literal and raw server errors never enter diagnostics', async () => {
    const attack = '<img src=x onerror="syntheticExecuted=true">.txt';
    const h = harness(); h.route('literal', { ...completeDecode, originalFilename: attack }); h.load(); h.choose('encode', file(attack)); assert.equal(h.el('encode-selection').textContent, attack);
    h.choose('decode', file('one.png')); h.submit('decode-form'); h.uploads[0].reply({ sessionId: 'literal' }); await until(() => h.view('decode') === 'result');
    assert.equal(h.el('original-filename').textContent, attack); assert.equal(h.el('original-filename').children.length, 0);
    h.route('raw-error', { stage: 'error', error: `Synthetic confidential error: ${attack}` }); h.click('decode-reset'); h.choose('decode', file('one.png')); h.submit('decode-form'); h.uploads[1].reply({ sessionId: 'raw-error' });
    await until(() => !h.el('decode-error').hidden); assert.equal(h.el('decode-error').textContent.includes(attack), false); assert.equal(h.el('diagnostic-log').textContent.includes(attack), false);
});

test('UI state: page departure aborts pending work; history restoration resumes status only', async () => {
    const h = harness(); h.route('restore', { stage: 'generating', progress: 10 }); h.load(); h.choose('encode', file()); h.submit('encode-form');
    const beforeUpload = h.window.emit('beforeunload'); assert.equal(beforeUpload.defaultPrevented, true);
    h.uploads[0].reply({ sessionId: 'restore' }); await until(() => h.el('encode-progress-bar').value === 10);
    assert.equal(h.window.emit('beforeunload').defaultPrevented, false);
    h.window.emit('pagehide'); h.route('restore', completeEncode); h.window.emit('pageshow', { persisted: true }); await until(() => h.view('encode') === 'result'); assert.equal(h.uploads.length, 1);
});


test('UI state: expired result metadata blocks dead links, while exact deadlines are shown', async () => {
    const h = harness({ search: '?session=expired-result' }); h.route('expired-result', completeEncode); h.metadata({ error: 'File not found' }, 404); h.load();
    await until(() => !h.el('encode-error').hidden);
    assert.match(h.el('encode-error').textContent, /no longer available|expired/i);
    assert.equal(h.el('encode-result').hidden, true); assert.equal(h.el('download-zip').getAttribute('href'), null); assert.equal(h.window.location.search, '');
    const current = harness({ search: '?session=current-result' }); current.route('current-result', completeEncode);
    const expiresAt = Date.now() + 3600000; current.metadata({ expiresAt }); current.load(); await until(() => current.view('encode') === 'result');
    assert.ok(current.el('encode-deadline').textContent.includes(new Date(expiresAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })));
    const offline = harness({ search: '?session=metadata-offline' }); offline.route('metadata-offline', completeEncode); offline.metadata(() => Promise.reject(new Error('synthetic offline'))); offline.load();
    await until(() => offline.view('encode') === 'result'); assert.match(offline.el('encode-deadline').textContent, /1 hour/);
});
