'use strict';

// This client uses the existing server API and password derivation protocol.
// Files, keys, session IDs, bearer links and raw server errors never enter the log.
const debugOutput = document.getElementById('diagnostic-log');
function debugLog(message) {
    const entry = document.createElement('div');
    const time = document.createElement('span');
    time.textContent = `${new Date().toLocaleTimeString()}  `;
    entry.appendChild(time);
    entry.appendChild(document.createTextNode(String(message)));
    debugOutput.appendChild(entry);
    if (debugOutput.children.length > 50) debugOutput.firstElementChild.remove();
}
// Clear debug button
const $ = id => document.getElementById(id);
$('clear-diagnostics').addEventListener('click', () => debugOutput.replaceChildren());
const MAX_SIZE = 10 * 1024 * 1024 * 1024;
const pathname = window.location.pathname;
const BASE_PATH = pathname.endsWith('/') ? pathname : pathname.slice(0, pathname.lastIndexOf('/') + 1);
const modes = ['encode', 'decode'];
const jobs = Object.fromEntries(modes.map(mode => [mode, {
    mode, files: [], view: 'choose', generation: 0, busy: false,
    xhr: null, controller: null, timer: null, session: null,
    salt: null, fileId: null, pngCount: 0, shownPngs: 0
}]));
let activeMode = 'encode';
let copyGeneration = 0;

function formatSize(bytes) {
    if (!bytes) return '0 bytes';
    const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3);
    return `${Number((bytes / 1024 ** unit).toFixed(1))} ${['bytes', 'KB', 'MB', 'GB'][unit]}`;
}

function focusInView(mode, selector = 'h2') {
    if (activeMode !== mode) return;
    const el = $(`${mode}-panel`).querySelector(selector === 'h2' ? '.view:not([hidden]) h2' : selector);
    if (el) { el.setAttribute('tabindex', '-1'); el.focus({ preventScroll: true }); }
}

function showView(mode, view, focus = false) {
    const job = jobs[mode];
    job.view = view;
    for (const name of ['choose', 'review', 'progress', 'result']) $(`${mode}-${name}`).hidden = name !== view;
    if (mode === 'decode') $('password-panel').hidden = view !== 'password';
    $(`${mode}-reset-row`).hidden = view === 'choose' && !job.files.length;
    $(`${mode}-keep`).hidden = !job.files.length;
    $(`${mode}-panel`).querySelectorAll('.steps li').forEach(li => {
        const step = view === 'password' || view === 'progress' ? 'review' : view;
        li.classList.toggle('done', ['choose', 'review', 'result'].indexOf(li.dataset.step) < ['choose', 'review', 'result'].indexOf(step));
        if (li.dataset.step === step) li.setAttribute('aria-current', 'step');
        else li.removeAttribute('aria-current');
    });
    if (focus) focusInView(mode);
}

function clearError(mode) {
    $(`${mode}-error`).hidden = true;
    $(`${mode}-error`).textContent = '';
    $(`${mode}-retry`).hidden = true;
}

function showError(mode, message, { statusRetry = false } = {}) {
    const job = jobs[mode];
    job.busy = false;
    setDisabled(mode, false);
    const el = $(`${mode}-error`);
    el.textContent = message;
    el.hidden = false;
    if (statusRetry) {
        showView(mode, 'progress');
        $(`${mode}-status`).textContent = 'Status check paused';
        $(`${mode}-retry`).hidden = false;
    } else {
        showView(mode, job.files.length ? 'review' : 'choose');
    }
    if (activeMode === mode) { el.setAttribute('tabindex', '-1'); el.focus({ preventScroll: true }); }
    debugLog(mode === 'encode' ? 'Hide: attention needed.' : 'Recover: attention needed.');
}

function setDisabled(mode, disabled) {
    $(`${mode}-start`).disabled = disabled;
    if (mode === 'decode') $('password-submit').disabled = disabled;
}

// Bump the generation BEFORE aborting. Late XHR, fetch and crypto completions
// can then never write into a newer attempt or a cleared screen.
function stopJob(mode) {
    const job = jobs[mode];
    job.generation++;
    clearTimeout(job.timer);
    job.timer = null;
    job.controller?.abort();
    job.controller = null;
    job.xhr?.abort();
    job.xhr = null;
    job.busy = false;
    setDisabled(mode, false);
    return job.generation;
}

function resetPassword(id, clear = true) {
    if (clear) $(id).value = '';
    $(id).type = 'password';
    const toggle = document.querySelector(`[data-reveal="${id}"]`);
    toggle.textContent = 'Show';
    toggle.setAttribute('aria-pressed', 'false');
}

function clearSessionUrl() {
    const url = new URL(window.location.href);
    url.searchParams.delete('session');
    window.history.replaceState(null, '', url);
}

function reset(mode, focus = true) {
    stopJob(mode);
    Object.assign(jobs[mode], { files: [], session: null, salt: null, fileId: null, pngCount: 0, shownPngs: 0 });
    $(`${mode}-file-input`).value = '';
    clearError(mode);
    setProgress(mode, 'Ready', null);
    resetPassword(`${mode}-password`);
    if (mode === 'encode') {
        $('encode-return').hidden = true;
        $('encode-return').open = false;
        $('return-url').value = '';
        $('copy-status').textContent = '';
        copyGeneration++;
        $('download-zip').removeAttribute('href');
        $('png-gallery').replaceChildren();
        $('png-details').open = false;
        $('png-size-slider').value = '10';
        $('png-size-value').value = '10';
        clearSessionUrl();
    } else {
        $('password-error').hidden = true;
        $('download-original').removeAttribute('href');
        $('original-filename').textContent = '';
    }
    showView(mode, 'choose', focus);
}

function switchMode(mode, updateHistory = true) {
    activeMode = mode;
    modes.forEach(name => {
        const tab = $(name === 'encode' ? 'hide-tab' : 'recover-tab');
        tab.setAttribute('aria-selected', String(name === mode));
        tab.tabIndex = name === mode ? 0 : -1;
        $(`${name}-panel`).hidden = name !== mode;
    });
    if (updateHistory) {
        const hash = mode === 'encode' ? '#hide' : '#recover';
        if (window.location.hash !== hash) window.history.pushState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
    }
}

for (const [index, tab] of [$('hide-tab'), $('recover-tab')].entries()) {
    tab.addEventListener('click', () => switchMode(tab.dataset.mode));
    tab.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
        const target = $(next ? 'recover-tab' : 'hide-tab');
        switchMode(target.dataset.mode);
        target.focus();
    });
}
function navigateHistory() {
    switchMode(window.location.hash === '#recover' ? 'decode' : 'encode', false);
    // History navigates task tabs, never resurrects a reset job or reuploads.
    // Keep the address consistent with the job still displayed in this page.
    const url = new URL(window.location.href);
    if (jobs.encode.session) url.searchParams.set('session', jobs.encode.session);
    else url.searchParams.delete('session');
    window.history.replaceState(null, '', url);
}
window.addEventListener('popstate', navigateHistory);
window.addEventListener('hashchange', navigateHistory);
$('go-recover').addEventListener('click', () => { switchMode('decode'); $('recover-tab').focus(); });

function validateSelection(mode, files) {
    if (!files.length) return 'Choose a file to continue.';
    if (mode === 'encode' && files.length !== 1) return 'Choose one file at a time to hide.';
    if (files.some(file => file.size === 0)) return 'This selection includes an empty file. Choose a non-empty file.';
    if (files.some(file => file.size > MAX_SIZE)) return 'Each file must be 10 GB or smaller. Choose a smaller file.';
    if (mode === 'decode') {
        const isZip = file => /\.zip$/i.test(file.name);
        const isPng = file => /\.png$/i.test(file.name);
        if (files.some(file => !isZip(file) && !isPng(file))) return 'Choose a ZIP bundle or PNG images created by InPlainSight.';
        if (files.some(isZip) && (files.length !== 1 || !isZip(files[0]))) return 'Choose one ZIP bundle, or select all PNGs together. Don’t mix ZIPs and PNGs.';
    }
    return null;
}

function selectFiles(mode, selected) {
    const job = jobs[mode];
    if (job.busy) return;
    const files = Array.from(selected);
    if (!files.length) return; // Closing the system picker leaves the current choice intact.
    const error = validateSelection(mode, files);
    if (error) { showError(mode, error); return; }
    stopJob(mode);
    job.files = files;
    job.session = null;
    job.salt = null;
    clearError(mode);
    if (mode === 'encode') {
        $('encode-return').hidden = true;
        $('return-url').value = '';
        $('copy-status').textContent = '';
        copyGeneration++;
        clearSessionUrl();
    } else resetPassword('decode-password');
    $(`${mode}-selection`).textContent = files.length === 1 ? files[0].name : `${files.length} PNG images`;
    $(`${mode}-size`).textContent = `${formatSize(files.reduce((sum, file) => sum + file.size, 0))}${files.length > 1 ? ' total' : ''}`;
    if (mode === 'decode') $('decode-file-list').textContent = files.length > 1 ? files.map(file => file.name).join(' · ') : '';
    showView(mode, 'review', true);
}

modes.forEach(mode => {
    const input = $(`${mode}-file-input`);
    input.addEventListener('change', () => { selectFiles(mode, input.files); input.value = ''; });
    const drop = $(`${mode}-drop-zone`);
    for (const type of ['dragenter', 'dragover']) drop.addEventListener(type, event => { event.preventDefault(); drop.classList.add('drag-over'); });
    for (const type of ['dragleave', 'drop']) drop.addEventListener(type, event => { event.preventDefault(); drop.classList.remove('drag-over'); });
    drop.addEventListener('drop', event => selectFiles(mode, event.dataTransfer.files));
    $(`${mode}-keep`).addEventListener('click', () => { clearError(mode); showView(mode, 'review', true); });
    $(`${mode}-back`).addEventListener('click', () => { stopJob(mode); clearError(mode); showView(mode, 'choose', true); });
    $(`${mode}-reset`).addEventListener('click', () => reset(mode));
    $(`${mode}-retry`).addEventListener('click', () => {
        const job = jobs[mode];
        if (job.busy || !job.session) return;
        const generation = stopJob(mode);
        job.busy = true;
        clearError(mode);
        setDisabled(mode, true);
        setProgress(mode, 'Checking the job again…', null);
        poll(mode, generation);
    });
    $(`${mode}-form`).addEventListener('submit', event => { event.preventDefault(); start(mode); });
});
// Prevent a dropped file outside a drop target from replacing the application.
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', event => event.preventDefault());
$('png-size-slider').addEventListener('input', event => { $('png-size-value').value = event.target.value; });
document.querySelectorAll('[data-reveal]').forEach(button => button.addEventListener('click', () => {
    const input = $(button.dataset.reveal);
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    button.textContent = reveal ? 'Hide' : 'Show';
    button.setAttribute('aria-pressed', String(reveal));
}));

function setProgress(mode, text, amount = null) {
    $(`${mode}-status`).textContent = text;
    const bar = $(`${mode}-progress-bar`);
    if (typeof amount === 'number' && Number.isFinite(amount)) bar.value = Math.min(100, Math.max(0, amount));
    else bar.removeAttribute('value');
}

function publicError(error) {
    // Match known API errors, but never echo arbitrary server strings or stacks.
    const message = typeof error === 'string' ? error : '';
    if (/Incorrect password/i.test(message)) return 'That password didn’t unlock this file. Check it and try again.';
    if (/File not found|Encryption key not found|expired/i.test(message)) return 'This file is no longer available on the server. It may have expired. Saved images alone can’t recover it; use your original file.';
    if (/different files|inconsistent counts/i.test(message)) return 'These images don’t belong to one complete set. Choose the original ZIP or all PNGs from the same file.';
    if (/Duplicate|invalid PNG|Invalid encrypted PNG|size mismatch|No PNG|Unsupported image|corrupt/i.test(message)) return 'These images couldn’t be read as a complete file. Use the original, unchanged PNGs or ZIP bundle, with each PNG included once.';
    if (/protection data|protected key|wrapped|wrapper/i.test(message)) return 'This protected file can’t be unlocked. Check your password and use the original images. If it still fails, create a new set from the original file.';
    return 'The server couldn’t process this file. Check your selection and try again. If it keeps happening, try a smaller file or return later.';
}

async function start(mode, passwordAttempt = false) {
    const job = jobs[mode];
    if (job.busy) return;
    const error = validateSelection(mode, job.files);
    if (error) { showError(mode, error); return; }
    const generation = stopJob(mode);
    job.busy = true;
    job.session = null;
    if (mode === 'encode') {
        $('encode-return').hidden = true;
        $('return-url').value = '';
        $('copy-status').textContent = '';
        copyGeneration++;
        clearSessionUrl();
    }
    clearError(mode);
    $('password-error').hidden = true;
    setDisabled(mode, true);
    showView(mode, 'progress', true);
    setProgress(mode, 'Preparing your file…', null);
    let password = mode === 'encode' ? $('encode-password').value.trim() : $('decode-password').value.trim();
    const form = new FormData();
    try {
        if (mode === 'encode') {
            form.append('file', job.files[0]);
            form.append('targetPngSizeMB', $('png-size-slider').value);
            if (password) {
                setProgress(mode, 'Preparing password protection…', null);
                const salt = window.crypto.getRandomValues(new Uint8Array(32));
                const iv = window.crypto.getRandomValues(new Uint8Array(12));
                const derived = await deriveKeyFromPassword(password, salt);
                const raw = await window.crypto.subtle.exportKey('raw', derived);
                form.append('passwordProtected', 'true');
                form.append('salt', arrayToBase64(salt));
                form.append('iv', arrayToBase64(iv));
                form.append('derivedKey', arrayToBase64(new Uint8Array(raw)));
            }
        } else {
            for (const file of job.files) {
                // The existing ZIP route is case sensitive; keep its protocol intact.
                form.append('files', file, /\.zip$/i.test(file.name) ? file.name.replace(/\.zip$/i, '.zip') : file.name);
            }
            if (passwordAttempt) {
                if (!job.salt || !password) throw new Error('Password preparation failed');
                setProgress(mode, 'Preparing your password…', null);
                const key = await deriveKeyFromPassword(password, base64ToArray(job.salt));
                const raw = await window.crypto.subtle.exportKey('raw', key);
                form.append('derivedKey', arrayToBase64(new Uint8Array(raw)));
            }
        }
        if (job.generation !== generation) return;
        // Keep encode protection intent through upload/processing failures.
        // Retain it only in this page's field until success or explicit reset.
        // Otherwise a one-click retry could silently create an unprotected file.
        resetPassword(`${mode}-password`, mode !== 'encode');
        password = '';
        upload(mode, generation, form, passwordAttempt ? 'decode-with-password' : mode);
    } catch {
        if (job.generation !== generation) return;
        resetPassword(`${mode}-password`, mode !== 'encode');
        showError(mode, 'Your browser couldn’t prepare password protection. Use a current browser over HTTPS and try again.');
    }
}

function upload(mode, generation, form, endpoint) {
    const job = jobs[mode];
    const xhr = new XMLHttpRequest();
    job.xhr = xhr;
    xhr.timeout = 2 * 60 * 60 * 1000;
    const current = () => job.generation === generation;
    setProgress(mode, mode === 'encode' ? 'Uploading your file…' : 'Uploading your images…', null);
    debugLog(mode === 'encode' ? 'Hide: upload started.' : 'Recover: upload started.');
    xhr.upload.addEventListener('progress', event => {
        if (!current()) return;
        const percent = event.lengthComputable ? Math.round(event.loaded / event.total * 100) : null;
        setProgress(mode, percent === null ? 'Uploading…' : percent === 100 ? 'Upload sent. Waiting for the server…' : `Uploading… ${percent}%`, percent);
    });
    xhr.addEventListener('load', () => {
        if (!current()) return;
        job.xhr = null;
        if (xhr.status < 200 || xhr.status >= 300) {
            showError(mode, xhr.status === 413 ? 'The server rejected this upload size. Choose a smaller file and try again.' : 'The upload wasn’t accepted. Your selection is still here; check your connection and try again.');
            return;
        }
        try {
            const response = JSON.parse(xhr.responseText);
            if (!response || typeof response.sessionId !== 'string' || !response.sessionId || response.sessionId.length > 200) throw new Error('Invalid session');
            job.session = response.sessionId;
            if (mode === 'encode') showReturnLink(response.sessionId);
            setProgress(mode, mode === 'encode' ? 'Upload complete. Creating PNG images…' : 'Upload complete. Checking images…', null);
            poll(mode, generation);
        } catch {
            showError(mode, 'The upload response couldn’t be read. The server may have received it. You can try again, but that may create a second temporary job.');
        }
    });
    xhr.addEventListener('error', () => { if (current()) showError(mode, 'The connection was interrupted. Your selection is still here. Check your connection before trying again; the server may have received part of the upload.'); });
    xhr.addEventListener('timeout', () => { if (current()) showError(mode, 'The upload timed out. Try a smaller file or a faster connection. Your selection is still here.'); });
    xhr.addEventListener('abort', () => { if (current()) showError(mode, 'The upload was interrupted. Your selection is still here.'); });
    xhr.open('POST', `${BASE_PATH}api/${endpoint}`, true);
    try { xhr.send(form); }
    catch { if (current()) showError(mode, 'The upload couldn’t start. Check your connection and try again.'); }
}

async function poll(mode, generation) {
    const job = jobs[mode];
    if (generation !== job.generation) return;
    const controller = new AbortController();
    job.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
        const response = await fetch(`${BASE_PATH}api/progress/${encodeURIComponent(job.session)}`, { signal: controller.signal, cache: 'no-store' });
        if (generation !== job.generation) return;
        if (response.status === 404) {
            job.session = null;
            if (mode === 'encode') { $('encode-return').hidden = true; clearSessionUrl(); }
            showError(mode, 'This job is no longer available. It may have expired or the server may have restarted. If you kept the PNGs, try Recover a file; otherwise choose the original file again.');
            return;
        }
        if (!response.ok) throw new Error('Status unavailable');
        const data = await response.json();
        if (generation !== job.generation) return;
        const stages = { starting: 'Starting…', splitting: 'Preparing the file…', encrypting: 'Protecting your file…', generating: 'Creating PNG images…', zipping: 'Packing your ZIP bundle…', reading: 'Reading your images…', decrypting: 'Recovering your file…' };
        if (data.stage === 'complete') {
            await finish(mode, data, generation);
        } else if (data.stage === 'password_required' && mode === 'decode') {
            job.busy = false;
            job.salt = data.salt;
            setDisabled(mode, false);
            if (typeof job.salt !== 'string' || !job.salt) { showError(mode, 'The server couldn’t prepare the password check. Choose the original images and try again.'); return; }
            showPassword();
        } else if (data.stage === 'incomplete') {
            const total = Number.isSafeInteger(data.totalCount) && data.totalCount > 0 ? data.totalCount : 'the';
            const missing = Number.isSafeInteger(data.missingCount) && data.missingCount > 0 ? `${data.missingCount} image${data.missingCount === 1 ? ' is' : 's are'} missing. ` : 'Some images are missing. ';
            showError(mode, `${missing}Choose all ${total} PNGs together, or the original ZIP bundle.`);
        } else if (data.stage === 'error') {
            if (mode === 'decode' && job.salt && /Incorrect password/i.test(data.error || '')) showPassword(publicError(data.error));
            else showError(mode, publicError(data.error));
        } else if (Object.hasOwn(stages, data.stage)) {
            const percent = Number.isFinite(data.progress) ? data.progress : null;
            setProgress(mode, stages[data.stage], percent);
            // Schedule only AFTER this request completes; never overlap polls.
            job.timer = setTimeout(() => poll(mode, generation), 750);
        } else throw new Error('Unrecognized status');
    } catch {
        if (generation === job.generation) showError(mode, 'We couldn’t check this job. It may still be running. Check your connection, then check its status again without uploading a second copy.', { statusRetry: true });
    } finally {
        clearTimeout(timeout);
        if (generation === job.generation) job.controller = null;
    }
}

function showPassword(message = '') {
    jobs.decode.busy = false;
    setDisabled('decode', false);
    resetPassword('decode-password');
    $('password-error').textContent = message;
    $('password-error').hidden = !message;
    showView('decode', 'password');
    if (activeMode === 'decode') $('decode-password').focus({ preventScroll: true });
}
$('password-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!$('decode-password').value.trim()) {
        $('password-error').textContent = 'Enter the file password to continue.';
        $('password-error').hidden = false;
        $('decode-password').focus();
        return;
    }
    start('decode', true);
});
$('password-back').addEventListener('click', () => {
    stopJob('decode');
    resetPassword('decode-password');
    $('password-error').hidden = true;
    clearError('decode');
    showView('decode', 'review', true);
});
$('password-panel').addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); $('password-back').click(); }
});

function showReturnLink(session) {
    const url = new URL(BASE_PATH, window.location.origin);
    url.searchParams.set('session', session);
    $('return-url').value = url.href;
    $('encode-return').hidden = false;
    const current = new URL(window.location.href);
    current.searchParams.set('session', session);
    window.history.replaceState(null, '', current);
}
$('copy-link').addEventListener('click', async () => {
    const generation = copyGeneration;
    const value = $('return-url').value;
    try {
        await navigator.clipboard.writeText(value);
        if (generation === copyGeneration) $('copy-status').textContent = 'Link copied. Keep it private.';
    } catch {
        if (generation !== copyGeneration) return;
        $('return-url').focus();
        $('return-url').select();
        $('copy-status').textContent = 'Copy didn’t work here. Select and copy the link above.';
    }
});

async function finish(mode, data, generation) {
    const job = jobs[mode];
    if (typeof data.downloadToken !== 'string' || !data.downloadToken) throw new Error('Missing download');
    if (mode === 'encode' && (typeof data.fileId !== 'string' || !Number.isSafeInteger(data.pngCount) || data.pngCount < 1)) throw new Error('Missing images');
    job.busy = false;
    setDisabled(mode, false);
    setProgress(mode, 'Complete', 100);
    if (mode === 'decode') {
        $('original-filename').textContent = typeof data.originalFilename === 'string' ? data.originalFilename : 'Recovered file';
        $('download-original').href = `${BASE_PATH}api/download/${encodeURIComponent(data.downloadToken)}`;
        showView(mode, 'result', true);
    } else {
        job.fileId = data.fileId;
        job.pngCount = data.pngCount;
        job.shownPngs = 0;
        $('png-gallery').replaceChildren();
        $('png-details').open = false;
        $('download-zip').href = `${BASE_PATH}api/download/${encodeURIComponent(data.downloadToken)}`;
        $('encode-result-summary').textContent = `${data.pngCount} PNG image${data.pngCount === 1 ? '' : 's'} created. Keep the whole set to recover your file.`;
        $('png-count').textContent = `(${data.pngCount})`;
        $('encode-deadline').textContent = 'Recover as soon as possible. Files expire about 1 hour after creation.';
        job.busy = true;
        setDisabled(mode, true);
        setProgress(mode, 'Checking download availability…', null);
        // A definite 404 means the file was removed even if its in-memory
        // session still says complete. Network/server failures are advisory.
        const controller = new AbortController();
        job.controller = controller;
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
            const response = await fetch(`${BASE_PATH}api/file/${encodeURIComponent(data.fileId)}`, { signal: controller.signal, cache: 'no-store' });
            if (generation !== job.generation) return;
            if (response.status === 404) {
                job.session = null;
                job.fileId = null;
                $('encode-return').hidden = true;
                $('download-zip').removeAttribute('href');
                clearSessionUrl();
                showError(mode, 'This file is no longer available on the server. It may have expired. The saved job can’t provide downloads; choose your original file to create a new set.');
                return;
            }
            const metadata = response.ok ? await response.json() : null;
            if (generation !== job.generation) return;
            if (metadata && Number.isFinite(metadata.expiresAt)) {
                const date = new Date(metadata.expiresAt);
                if (!Number.isNaN(date.getTime())) $('encode-deadline').textContent = `${date.getTime() <= Date.now() ? 'Recovery deadline has passed: ' : 'Recover before '}${date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} (your local time).`;
            }
        } catch { /* Keep the conservative default expiry guidance. */ }
        finally { clearTimeout(timeout); }
        if (generation !== job.generation) return;
        job.busy = false;
        resetPassword('encode-password');
        setDisabled(mode, false);
        showView(mode, 'result', true);
    }
    debugLog(mode === 'encode' ? 'Hide: PNG bundle ready.' : 'Recover: file ready.');
}

function addPngs() {
    const job = jobs.encode;
    if (!job.fileId || job.view !== 'result') return;
    const end = Math.min(job.shownPngs + 12, job.pngCount);
    for (let index = job.shownPngs; index < end; index++) {
        const card = document.createElement('div');
        card.className = 'png-item';
        const url = `${BASE_PATH}api/png/${encodeURIComponent(job.fileId)}/${index}`;
        const image = document.createElement('img');
        image.loading = 'lazy';
        image.src = url;
        image.alt = `Encrypted PNG ${index + 1} of ${job.pngCount}`;
        const link = document.createElement('a');
        link.href = url;
        link.download = `inplainsight-${index + 1}.png`;
        link.textContent = `Download PNG ${index + 1}`;
        card.append(image, link);
        $('png-gallery').appendChild(card);
    }
    job.shownPngs = end;
    $('more-pngs').hidden = end >= job.pngCount;
    $('more-pngs').textContent = `Show more images (${end} of ${job.pngCount})`;
}
$('png-details').addEventListener('toggle', () => { if ($('png-details').open && !jobs.encode.shownPngs) addPngs(); });
$('more-pngs').addEventListener('click', addPngs);

window.addEventListener('beforeunload', event => {
    if (modes.some(mode => jobs[mode].busy && (mode === 'decode' || !jobs[mode].session))) {
        event.preventDefault();
        event.returnValue = '';
    }
});
window.addEventListener('pagehide', () => { modes.forEach(stopJob); });
window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    modes.forEach(mode => {
        const job = jobs[mode];
        if (job.view === 'progress' && job.session) {
            job.busy = true;
            setDisabled(mode, true);
            poll(mode, job.generation);
        } else if (job.view === 'progress') showError(mode, 'The upload was interrupted when you left this page. Choose your file and try again.');
    });
});

switchMode(window.location.hash === '#recover' ? 'decode' : 'encode', false);
const session = new URLSearchParams(window.location.search).get('session');
if (session) {
    if (session.length > 200) { clearSessionUrl(); showError('encode', 'This return link is invalid. Choose the original file again.'); }
    else {
        jobs.encode.session = session;
        jobs.encode.busy = true;
        setDisabled('encode', true);
        showReturnLink(session);
        showView('encode', 'progress');
        setProgress('encode', 'Checking your saved job…', null);
        poll('encode', jobs.encode.generation);
    }
}
debugLog('Workspace ready. Activity details stay on this page.');
