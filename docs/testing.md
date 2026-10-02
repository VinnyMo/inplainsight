# Regression tests

Run tests in an isolated checkout using synthetic data only. Do not point these
tests at production, copy a live database into the checkout, or use personal
files as fixtures.

## Server and security regressions

```sh
npm ci
npm test
```

The existing security suite exercises encryption, historical-file compatibility,
password enforcement, schema migration, and sanitized logging. It copies source
into a temporary directory and creates a synthetic database. Its isolated HTTP
server needs local port **3008** to be free.

## Dependency-free frontend behavior regressions

`test/ui-state.test.js` always runs with `npm test`. It loads the actual
`client/index.html`, `app-v2.js`, and `crypto-utils.js` into a minimal DOM/event
model, supplies synthetic XHR/fetch responses and controlled timers, and uses
real WebCrypto PBKDF2 for password assertions. Its 15 cases verify selection,
Start/Back/Reset, tab/history transitions, upload progress, interrupted and stale
requests, PNG/ZIP multipart data, password retry and cancellation, protected
encoding after failed uploads, malformed responses, session resume, expiry,
exact recovery deadlines, literal text rendering, and page departure/restoration.

```sh
node --test test/ui-state.test.js
```

This suite is a behavioral fallback for constrained runners. The DOM model does
not implement rendering, layout, native file pickers, browser focus semantics,
or native network/download behavior. Passing it does not establish those
browser properties.

## Guided-workflow browser regressions

`test/ui.test.js` is discovered by the same `npm test` command. It uses optional
Playwright tooling, with no new application/runtime dependency. When Playwright
is absent the browser suite reports a clearly labelled **skip**; the security
suite still runs. A skipped browser suite is not a verified UI pass.

Install Playwright in a separate tooling directory, or use an existing install:

```sh
npm install --prefix /tmp/inplainsight-browser-tools --no-save playwright
/tmp/inplainsight-browser-tools/node_modules/.bin/playwright install chromium
PLAYWRIGHT_MODULE_PATH=/tmp/inplainsight-browser-tools/node_modules/playwright \
  REQUIRE_UI_TESTS=1 npm test
```

To use a system Chromium instead of Playwright's downloaded browser:

```sh
PLAYWRIGHT_MODULE_PATH=/path/to/node_modules/playwright \
  PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium \
  REQUIRE_UI_TESTS=1 npm test
```

`PLAYWRIGHT_MODULE_PATH` accepts the package directory or its `index.mjs` file.
If Playwright is installed in this checkout, it is discovered automatically.
`REQUIRE_UI_TESTS=1` makes missing tooling a failure instead of a skip. An explicit
`PLAYWRIGHT_MODULE_PATH` also makes a missing/broken install a failure. Browser
launch failures are always failures when tooling is present; they are never
silently converted to skips.

Run just the browser suite while iterating:

```sh
PLAYWRIGHT_MODULE_PATH=/path/to/node_modules/playwright \
  PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium \
  node --test test/ui.test.js
```

The test runner needs permission to launch Chromium and create its local IPC
sockets. A sandbox that denies these operations must be configured by its owner
before browser verification can run. No application server or open port is
needed by the UI suite: all requests to the synthetic localhost origin are
intercepted, frontend files are read from `client/`, API replies are mocked, and
external URLs are blocked. The suite does not open the working database.

### Coverage

- File selection is local; only explicit Start initiates upload
- File and option preservation when going Back, plus empty/oversized/unsupported
  files and invalid ZIP/PNG combinations
- One upload despite duplicate submissions; protected upload fields contain the
  derived key without the plain password
- Processing feedback and usable, explicit download links
- Reset during upload or polling ignores late responses
- Independent Hide and Recover flows survive tab switches
- Multipart PNG uploads and normalized uppercase ZIP extensions
- Inline password challenge, wrong-password retry with every file preserved,
  and Back from the password panel
- Missing PNG parts, failed/malformed upload replies, network status failures,
  retry without another upload, and malformed status replies
- Session-link resume and expired/missing sessions
- Filename rendering as literal text, no HTML execution, and no secrets in
  browser console output
- Keyboard tab navigation and no horizontal overflow at 360, 768, and 1280 pixels

These UI fixtures intentionally do not verify the cryptographic validity of the
placeholder PNG/ZIP bytes. Actual encoding, decoding, and password enforcement
are covered by `test/security.test.js`. They also do not replace a manual check
of real operating-system file pickers, assistive technology, Safari/iOS, browser
clipboard permissions, and actual download behavior.


## Verification record for the guided-workflow change

On 2026-10-02, the isolated checkout passed `npm test`: **12 existing security
regressions and 15 frontend state regressions**. The optional browser group was
skipped because Playwright was not configured as a checkout dependency. Its
**17 scenario groups are authored but have not run in Chromium** in this
execution environment. Syntax checks (`node --check`) also passed for both UI
test files.

An installed Playwright and system Chromium were tested with this isolated
smoke command (all page requests were intercepted with synthetic HTML):

```sh
node --input-type=module -e "import { chromium } from '/opt/codex/cua_node/lib/node_modules/playwright/index.mjs'; const b=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--disable-dev-shm-usage']}); const p=await b.newPage(); await p.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<h1>Synthetic fixture</h1>'})); await p.goto('http://localhost:4179/'); console.log(await p.locator('h1').textContent()); await b.close();"
```

Chromium failed before creating a page with
`process_singleton_posix.cc: socket() failed: Operation not permitted (1)`.
A sandbox-escalated attempt encountered the same host IPC restriction. Browser
assertions, responsive rendering, and browser accessibility checks therefore
remain unverified; run the documented Playwright command on a capable runner
before treating them as passed. No production endpoint was contacted.
