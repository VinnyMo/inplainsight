/**
 * Browser regressions for the guided file workflows.
 * No production service, working database, or actual upload is used: every URL
 * is intercepted, static assets come from client/, and API data is synthetic.
 * See docs/testing.md for the optional Playwright/browser setup.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pbkdf2Sync } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const client = path.join(root, 'client');
const origin = 'http://localhost:4179';
const base = '/inplainsight/';
const maxFileSize = 10 * 1024 ** 3;
const salt = Buffer.alloc(32, 7).toString('base64');
const iv = Buffer.alloc(12, 9).toString('base64');
const file = (name = 'synthetic.txt', body = 'Only synthetic test content', mimeType = 'text/plain') => ({ name, mimeType, buffer: Buffer.from(body) });
const png = (name = 'synthetic_1.png') => file(name, 'Synthetic PNG placeholder: the API is mocked', 'image/png');
const zip = (name = 'synthetic.zip') => file(name, 'Synthetic ZIP placeholder: the API is mocked', 'application/zip');
const encoded = { stage: 'complete', progress: 100, fileId: 'synthetic-file', pngCount: 2, downloadToken: 'synthetic-zip-token' };
const decoded = { stage: 'complete', progress: 100, originalFilename: 'synthetic.txt', downloadToken: 'synthetic-original-token' };
const protectedStatus = { stage: 'password_required', passwordRequired: true, totalCount: 2, uploadedCount: 2, salt, iv };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function loadPlaywright() {
    if (!process.env.PLAYWRIGHT_MODULE_PATH) return import('playwright');
    let filename = path.resolve(process.env.PLAYWRIGHT_MODULE_PATH);
    if ((await fs.stat(filename)).isDirectory()) filename = path.join(filename, 'index.mjs');
    return import(pathToFileURL(filename).href);
}
let playwright, loadError;
try { playwright = await loadPlaywright(); } catch (error) { loadError = error; }
const requireBrowser = process.env.REQUIRE_UI_TESTS === '1' || Boolean(process.env.PLAYWRIGHT_MODULE_PATH);
const skip = !playwright && !requireBrowser
    ? 'Optional UI tests: install Playwright or set PLAYWRIGHT_MODULE_PATH; see docs/testing.md. Security tests still run.'
    : false;

async function eventually(check, message, timeout = 7000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await check()) return;
        await wait(25);
    }
    assert.fail(message);
}
async function visible(page, selector) { await page.locator(selector).waitFor({ state: 'visible' }); }
async function hidden(page, selector) { await page.locator(selector).waitFor({ state: 'hidden' }); }
async function textMatches(page, selector, expression) {
    await eventually(async () => expression.test(await page.locator(selector).innerText()), `${selector} should contain ${expression}`);
}
async function setPngSize(page, size) {
    await page.locator('#encode-review .options > summary').click();
    const slider = page.locator('#png-size-slider');
    await slider.focus(); await slider.press('Home');
    for (let value = 3; value < size; value++) await slider.press('ArrowRight');
}
async function select(page, mode, files) {
    if (mode === 'decode') await page.locator('#recover-tab').click();
    await page.locator(`#${mode}-file-input`).setInputFiles(files);
}
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

async function fixture(browser, t, run, { viewport = { width: 1280, height: 900 }, query = '' } = {}) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    const requests = [], unexpected = [], pageErrors = [], dialogs = [], consoleMessages = [];
    const routes = new Map();
    routes.set('GET /api/file/synthetic-file', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ expiresAt: Date.now() + 3600000, originalFilename: 'synthetic.txt', pngCount: 2 }) }));
    const api = {
        requests,
        on(method, pathname, handler) { routes.set(`${method} ${pathname}`, handler); return api; },
        json(method, pathname, data, status = 200) {
            return api.on(method, pathname, route => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) }));
        },
        count(pathname) { return requests.filter(request => request.pathname === pathname).length; },
        posts(pathname) { return requests.filter(request => request.pathname === pathname && request.method === 'POST'); },
        async received(pathname, count = 1) {
            await eventually(() => api.count(pathname) >= count, `Expected ${count} request(s) to ${pathname}`);
        }
    };
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('dialog', dialog => { dialogs.push(dialog.type()); void dialog.dismiss(); });
    page.on('console', message => consoleMessages.push(message.text()));
    await context.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        // Never let even a missing fixture request reach the real network.
        if (url.origin !== origin) return route.abort('blockedbyclient');
        if (url.pathname.startsWith(`${base}api/`)) {
            const pathname = url.pathname.slice(base.length - 1);
            const entry = { pathname, method: request.method(), body: request.postDataBuffer()?.toString('utf8') ?? '' };
            requests.push(entry);
            const handler = routes.get(`${request.method()} ${pathname}`);
            if (handler) return handler(route, entry);
            // Generated PNG previews can be requested by the result view.
            if (request.method() === 'GET' && /^\/api\/png\/synthetic-file\/\d+$/.test(pathname)) {
                return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') });
            }
            unexpected.push(`${request.method()} ${pathname}`);
            return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"No synthetic API fixture"}' });
        }
        const asset = url.pathname === base || url.pathname === `${base}index.html`
            ? 'index.html' : decodeURIComponent(url.pathname.slice(base.length));
        const filename = path.resolve(client, asset);
        if (!url.pathname.startsWith(base) || !filename.startsWith(`${client}${path.sep}`)) return route.fulfill({ status: 404, body: '' });
        const contentType = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }[path.extname(filename)] ?? 'application/octet-stream';
        try { return await route.fulfill({ contentType, body: await fs.readFile(filename) }); }
        catch (error) { if (error.code === 'ENOENT') return route.fulfill({ status: 404, body: '' }); throw error; }
    });
    try {
        await run({ page, api, consoleMessages, open: () => page.goto(`${origin}${base}${query}`) });
        assert.deepEqual(unexpected, [], 'No unexpected API requests');
        assert.deepEqual(pageErrors, [], 'No unhandled browser errors');
        assert.deepEqual(dialogs, [], 'Failures stay inline instead of interrupting with browser dialogs');
    } finally {
        await context.close();
    }
}

// Sequential cases intentionally use separate contexts so URL state, pending
// work, downloads, files, and password fields cannot leak between scenarios.
test('guided file workflows (isolated browser fixtures)', { skip, timeout: 180000 }, async t => {
    assert.ok(playwright, `Playwright is required but could not be loaded: ${loadError?.message}`);
    const browser = await playwright.chromium.launch({
        headless: true,
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
        args: ['--disable-dev-shm-usage']
    });
    try {
        await t.test('selection is local until explicit Start; Back preserves file and options', async t => fixture(browser, t, async ({ page, api, open }) => {
            await open();
            await visible(page, '#encode-choose');
            assert.equal(api.requests.length, 0);
            await select(page, 'encode', file());
            await visible(page, '#encode-review');
            await textMatches(page, '#encode-review', /synthetic\.txt/);
            await page.locator('#encode-password').fill('synthetic password');
            await setPngSize(page, 5);
            await page.locator('#encode-back').click();
            await visible(page, '#encode-choose');
            assert.equal(await page.locator('#encode-password').inputValue(), 'synthetic password');
            assert.equal(await page.locator('#png-size-slider').inputValue(), '5');
            assert.equal(api.requests.length, 0, 'selection and Back must not upload');
            await page.locator('#encode-file-input').setInputFiles([]);
            assert.equal(api.requests.length, 0, 'dismissing an empty picker must not upload');
            await select(page, 'encode', file());
            await visible(page, '#encode-review');
            assert.equal(await page.locator('#encode-password').inputValue(), 'synthetic password');
        }));

        await t.test('invalid files are rejected locally, including empty and oversized files', async t => fixture(browser, t, async ({ page, api, open }) => {
            await open();
            await select(page, 'encode', file('empty.txt', ''));
            await visible(page, '#encode-error');
            await textMatches(page, '#encode-error', /empty|zero|0 bytes/i);
            await page.evaluate(limit => {
                const input = document.querySelector('#encode-file-input');
                const transfer = new DataTransfer();
                const oversized = new File(['synthetic'], 'oversized.bin');
                Object.defineProperty(oversized, 'size', { value: limit + 1 });
                transfer.items.add(oversized); input.files = transfer.files;
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }, maxFileSize);
            await textMatches(page, '#encode-error', /10\s?(GB|GiB)|too large|limit/i);
            for (const files of [file('wrong.txt'), file('empty.png', '', 'image/png'), [png(), zip()], [zip('one.zip'), zip('two.zip')]]) {
                await select(page, 'decode', files);
                await visible(page, '#decode-error');
            }
            assert.equal(api.requests.length, 0);
        }));

        await t.test('explicit encode submits options once and never transmits the plain password', async t => fixture(browser, t, async ({ page, api, open }) => {
            const upload = deferred();
            api.on('POST', '/api/encode', async route => {
                await upload.promise;
                await route.fulfill({ contentType: 'application/json', body: '{"sessionId":"encode-options"}' });
            });
            api.json('GET', '/api/progress/encode-options', encoded);
            await open();
            await select(page, 'encode', file());
            await page.locator('#encode-password').fill('synthetic encode secret');
            await setPngSize(page, 5);
            await page.evaluate(() => {
                document.querySelector('#encode-form').requestSubmit();
                document.querySelector('#encode-form').requestSubmit();
            });
            await api.received('/api/encode');
            await visible(page, '#encode-progress');
            assert.equal(api.posts('/api/encode').length, 1, 'duplicate Start cannot duplicate the upload');
            const body = api.posts('/api/encode')[0].body;
            assert.match(body, /name="file"; filename="synthetic\.txt"/);
            assert.match(body, /name="targetPngSizeMB"\r\n\r\n5\r\n/);
            assert.match(body, /name="passwordProtected"\r\n\r\ntrue\r\n/);
            assert.match(body, /name="derivedKey"/);
            assert.equal(body.includes('synthetic encode secret'), false);
            upload.resolve();
            await visible(page, '#encode-result');
        }));

        await t.test('processing progress reaches a usable result without automatic download', async t => fixture(browser, t, async ({ page, api, open }) => {
            let complete = false;
            api.json('POST', '/api/encode', { sessionId: 'encode-progress' });
            api.on('GET', '/api/progress/encode-progress', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(complete ? encoded : { stage: 'generating', progress: 42 }) }));
            await open(); await select(page, 'encode', file()); await page.locator('#encode-start').click();
            await api.received('/api/progress/encode-progress');
            await visible(page, '#encode-progress');
            await textMatches(page, '#encode-status', /generat|creat|PNG|42/i);
            await eventually(async () => await page.locator('#encode-progress-bar').getAttribute('value') === '42', 'Reported processing progress is shown');
            complete = true;
            await visible(page, '#encode-result');
            const download = page.locator('#encode-result a[href*="api/download/"]');
            assert.equal(await download.count(), 1);
            assert.match(await download.getAttribute('href'), /api\/download\/synthetic-zip-token$/);
            assert.equal(api.requests.some(request => request.pathname.startsWith('/api/download/')), false);
        }));

        await t.test('Reset ignores a late upload response and clears only the current workflow', async t => fixture(browser, t, async ({ page, api, open }) => {
            const upload = deferred();
            api.on('POST', '/api/encode', async route => {
                await upload.promise;
                await route.fulfill({ contentType: 'application/json', body: '{"sessionId":"stale-upload"}' }).catch(() => {});
            });
            await open(); await select(page, 'encode', file()); await page.locator('#encode-start').click();
            await api.received('/api/encode'); await page.locator('#encode-reset').click();
            await visible(page, '#encode-choose'); upload.resolve(); await wait(100);
            await hidden(page, '#encode-result');
            assert.equal(api.count('/api/progress/stale-upload'), 0);
            assert.equal(await page.locator('#encode-file-input').inputValue(), '');
            assert.equal(await page.locator('#encode-password').inputValue(), '');
        }));

        await t.test('Reset ignores an in-flight status response', async t => fixture(browser, t, async ({ page, api, open }) => {
            const poll = deferred();
            api.json('POST', '/api/encode', { sessionId: 'stale-poll' });
            api.on('GET', '/api/progress/stale-poll', async route => {
                await poll.promise;
                await route.fulfill({ contentType: 'application/json', body: JSON.stringify(encoded) }).catch(() => {});
            });
            await open(); await select(page, 'encode', file()); await page.locator('#encode-start').click();
            await api.received('/api/progress/stale-poll'); await page.locator('#encode-reset').click();
            poll.resolve(); await wait(100); await visible(page, '#encode-choose'); await hidden(page, '#encode-result');
        }));

        await t.test('tabs keep Hide and Recover jobs independent while processing', async t => fixture(browser, t, async ({ page, api, open }) => {
            let encodeComplete = false;
            api.json('POST', '/api/encode', { sessionId: 'independent-encode' });
            api.on('GET', '/api/progress/independent-encode', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(encodeComplete ? encoded : { stage: 'encrypting', progress: 15 }) }));
            api.json('POST', '/api/decode', { sessionId: 'independent-decode' });
            api.json('GET', '/api/progress/independent-decode', decoded);
            await open(); await select(page, 'encode', file()); await page.locator('#encode-start').click();
            await api.received('/api/progress/independent-encode');
            await select(page, 'decode', [png(), png('synthetic_2.png')]);
            await visible(page, '#decode-review'); assert.equal(api.count('/api/decode'), 0);
            await page.locator('#decode-start').click(); await visible(page, '#decode-result');
            await page.locator('#hide-tab').click(); await visible(page, '#encode-progress');
            encodeComplete = true; await visible(page, '#encode-result');
            await page.locator('#encode-reset').click(); await page.locator('#recover-tab').click();
            await visible(page, '#decode-result'); assert.equal(api.count('/api/encode'), 1); assert.equal(api.count('/api/decode'), 1);
        }));

        await t.test('PNG bundles and uppercase ZIPs submit supported multipart files', async t => fixture(browser, t, async ({ page, api, open }) => {
            api.json('POST', '/api/decode', { sessionId: 'bundle-decode' });
            api.json('GET', '/api/progress/bundle-decode', decoded);
            await open(); await select(page, 'decode', [png('PART_1.PNG'), png('part_2.png')]);
            await page.locator('#decode-back').click(); await visible(page, '#decode-choose');
            assert.equal(api.count('/api/decode'), 0);
            await select(page, 'decode', [png('PART_1.PNG'), png('part_2.png')]);
            await page.locator('#decode-start').click(); await visible(page, '#decode-result');
            const body = api.posts('/api/decode')[0].body;
            assert.equal((body.match(/name="files"; filename=/g) ?? []).length, 2);
            assert.match(body, /filename="PART_1\.PNG"/);
            await page.locator('#decode-reset').click();
            await select(page, 'decode', zip('BUNDLE.ZIP')); await page.locator('#decode-start').click();
            await visible(page, '#decode-result');
            assert.match(api.posts('/api/decode')[1].body, /filename="BUNDLE\.zip"/);
        }));

        await t.test('password retry preserves every file and submits a derived key, never the password', async t => fixture(browser, t, async ({ page, api, open, consoleMessages }) => {
            api.json('POST', '/api/decode', { sessionId: 'protected-decode' });
            api.json('GET', '/api/progress/protected-decode', protectedStatus);
            let attempts = 0;
            api.on('POST', '/api/decode-with-password', route => {
                attempts++;
                return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ sessionId: `password-attempt-${attempts}` }) });
            });
            api.json('GET', '/api/progress/password-attempt-1', { stage: 'error', error: 'Incorrect password' });
            api.json('GET', '/api/progress/password-attempt-2', decoded);
            await open(); await select(page, 'decode', [png(), png('synthetic_2.png')]); await page.locator('#decode-start').click();
            await visible(page, '#password-panel'); await page.locator('#decode-password').fill('synthetic wrong password');
            await page.locator('#password-submit').click(); await visible(page, '#password-error');
            await textMatches(page, '#password-error', /password|try again/i);
            await page.locator('#decode-password').fill('synthetic correct password'); await page.locator('#password-submit').click();
            await visible(page, '#decode-result');
            assert.equal(api.posts('/api/decode-with-password').length, 2);
            for (const [index, request] of api.posts('/api/decode-with-password').entries()) {
                assert.equal((request.body.match(/name="files"; filename=/g) ?? []).length, 2);
                const password = index === 0 ? 'synthetic wrong password' : 'synthetic correct password';
                assert.equal(request.body.includes(password), false);
                const key = pbkdf2Sync(password, Buffer.from(salt, 'base64'), 600000, 32, 'sha256').toString('base64');
                assert.ok(request.body.includes(key), 'password retry derives the expected PBKDF2 key');
                assert.equal(consoleMessages.some(message => message.includes(password) || message.includes(key)), false);
            }
        }));

        await t.test('password Back cancels the prompt while preserving files for a fresh attempt', async t => fixture(browser, t, async ({ page, api, open }) => {
            api.json('POST', '/api/decode', { sessionId: 'cancel-password' });
            api.json('GET', '/api/progress/cancel-password', protectedStatus);
            await open(); await select(page, 'decode', zip()); await page.locator('#decode-start').click();
            await visible(page, '#password-panel'); await page.locator('#decode-password').fill('discard this synthetic password');
            await page.locator('#password-back').click(); await hidden(page, '#password-panel'); await visible(page, '#decode-review');
            await textMatches(page, '#decode-review', /synthetic\.zip/);
            assert.equal(api.count('/api/decode-with-password'), 0);
            assert.equal(await page.locator('#decode-password').inputValue(), '');
            await page.locator('#decode-start').click(); await visible(page, '#password-panel');
            assert.equal(api.count('/api/decode'), 2);
        }));

        await t.test('incomplete recovery explains missing parts and keeps the chosen files', async t => fixture(browser, t, async ({ page, api, open }) => {
            api.json('POST', '/api/decode', { sessionId: 'missing-parts' });
            api.json('GET', '/api/progress/missing-parts', { stage: 'incomplete', missingCount: 2, totalCount: 3, uploadedCount: 1 });
            await open(); await select(page, 'decode', png()); await page.locator('#decode-start').click();
            await visible(page, '#decode-error'); await textMatches(page, '#decode-error', /missing|incomplete|2 more/i);
            await hidden(page, '#decode-result'); await visible(page, '#decode-review');
            await textMatches(page, '#decode-review', /synthetic_1\.png/);
        }));

        await t.test('upload errors and malformed upload replies recover inline with selection intact', async t => {
            for (const response of [{ status: 500, body: '{"error":"Synthetic upload failure"}' }, { status: 200, body: '{not valid json' }, { status: 200, body: '{}' }]) {
                await fixture(browser, t, async ({ page, api, open }) => {
                    api.on('POST', '/api/encode', route => route.fulfill({ ...response, contentType: 'application/json' }));
                    await open(); await select(page, 'encode', file()); await page.locator('#encode-start').click();
                    await visible(page, '#encode-error'); await visible(page, '#encode-review'); await hidden(page, '#encode-result');
                    await textMatches(page, '#encode-review', /synthetic\.txt/);
                    assert.equal(api.posts('/api/encode').length, 1);
                    assert.equal(api.requests.some(request => request.pathname.startsWith('/api/progress/')), false);
                });
            }
        });

        await t.test('network status failure supports retry without uploading again', async t => fixture(browser, t, async ({ page, api, open }) => {
            let networkFails = true;
            api.json('POST', '/api/encode', { sessionId: 'retry-status' });
            api.on('GET', '/api/progress/retry-status', route => networkFails ? route.abort('failed') : route.fulfill({ contentType: 'application/json', body: JSON.stringify(encoded) }));
            await open(); await select(page, 'encode', file()); await page.locator('#encode-start').click();
            await visible(page, '#encode-retry'); await visible(page, '#encode-error');
            networkFails = false; await page.locator('#encode-retry').click(); await visible(page, '#encode-result');
            assert.equal(api.count('/api/encode'), 1);
        }));

        await t.test('malformed status replies do not produce bogus completion or endless polling', async t => {
            for (const data of [{}, { stage: 'complete', progress: 100 }, { stage: 'not-a-real-stage', progress: 30 }]) {
                await fixture(browser, t, async ({ page, api, open }) => {
                    api.json('POST', '/api/encode', { sessionId: 'malformed-status' });
                    api.json('GET', '/api/progress/malformed-status', data);
                    await open(); await select(page, 'encode', file()); await page.locator('#encode-start').click();
                    await visible(page, '#encode-error'); await hidden(page, '#encode-result');
                    const count = api.count('/api/progress/malformed-status'); await wait(1200);
                    assert.equal(api.count('/api/progress/malformed-status'), count, 'malformed replies stop the poll loop');
                });
            }
        });

        await t.test('a session link resumes without upload; an expired session shows recovery guidance', async t => {
            await fixture(browser, t, async ({ page, api, open, consoleMessages }) => {
                api.json('GET', '/api/progress/synthetic-resume', encoded);
                await open(); await visible(page, '#encode-result');
                assert.equal(api.count('/api/encode'), 0);
                assert.equal(consoleMessages.some(message => message.includes('synthetic-resume') || message.includes(encoded.downloadToken)), false);
            }, { query: '?session=synthetic-resume' });
            await fixture(browser, t, async ({ page, api, open }) => {
                api.json('GET', '/api/progress/synthetic-expired', { error: 'Session not found' }, 404);
                await open(); await visible(page, '#encode-error');
                await textMatches(page, '#encode-error', /expired|no longer|not found|start again|new file/i);
                await hidden(page, '#encode-result'); assert.equal(api.count('/api/encode'), 0);
            }, { query: '?session=synthetic-expired' });
        });

        await t.test('filenames and server failures render as text without executing HTML', async t => fixture(browser, t, async ({ page, api, open }) => {
            const attack = '<img src=x onerror="globalThis.syntheticExecuted=true">.txt';
            api.json('POST', '/api/decode', { sessionId: 'literal-filename' });
            api.json('GET', '/api/progress/literal-filename', { ...decoded, originalFilename: attack });
            await open(); await select(page, 'encode', file(attack));
            assert.ok((await page.locator('#encode-review').innerText()).includes(attack));
            await select(page, 'decode', png()); await page.locator('#decode-start').click(); await visible(page, '#decode-result');
            assert.ok((await page.locator('#decode-result').innerText()).includes(attack));
            assert.equal(await page.evaluate(() => globalThis.syntheticExecuted), undefined);
            assert.equal(await page.locator('#decode-result img[onerror]').count(), 0);
        }));

        await t.test('small-screen layouts fit and workflow tabs support keyboard navigation', async t => {
            for (const width of [360, 768, 1280]) {
                await fixture(browser, t, async ({ page, api, open }) => {
                    await open(); await select(page, 'encode', file(`${'long-synthetic-name-'.repeat(12)}.txt`));
                    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
                    assert.equal(fits, true, `No horizontal page overflow at ${width}px`);
                    await page.locator('#hide-tab').focus(); await page.keyboard.press('ArrowRight');
                    assert.equal(await page.locator('#recover-tab').getAttribute('aria-selected'), 'true');
                    assert.equal(await page.locator('#recover-tab').evaluate(element => element === document.activeElement), true);
                    await page.keyboard.press('ArrowLeft'); await visible(page, '#encode-review');
                    assert.equal(await page.locator('#hide-tab').getAttribute('aria-selected'), 'true');
                    assert.equal(api.requests.length, 0);
                    assert.equal(await page.locator('#encode-status').getAttribute('aria-live'), 'polite');
                    assert.equal(await page.locator('#encode-error').getAttribute('role'), 'alert');
                }, { viewport: { width, height: 800 } });
            }
        });
    } finally {
        await browser.close();
    }
});
