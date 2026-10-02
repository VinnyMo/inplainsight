# Guided Hide / Recover workflow

This change replaces only the served client and adds tests/documentation. The server APIs, encryption, database, upload limit, optional-password protocol and cleanup behavior are unchanged. It is based on security fix `0ca6b3c3ee6ac6ad81826ae5bd75ef8b4fa67212`.

## User-facing flow

- **Hide a file:** choose one non-empty file (up to 10 GB), review an optional password and optional PNG size, then explicitly start. Selecting or dropping a file never uploads automatically.
- **Recover a file:** choose one ZIP or every PNG belonging to one file, review, then explicitly start. A password is requested inline only when the server requires it. An incorrect password preserves the image selection for retry.
- **Results:** ZIP bundle is the primary download; individual PNGs are progressively shown in groups of 12. The recovered original has a separate explicit download. Nothing downloads automatically.
- **Change / Start over:** Change preserves the selection and options, with a way back to review. Start over clears that workflow and aborts its local request/status checks. It does not delete server files or cancel server processing that has already started.
- **Task switching:** Hide and Recover keep independent state. Tab switching and browser Back/Forward never start another upload. Late responses from reset/superseded attempts cannot mutate the new screen.
- **Failures:** the Hide password stays in its page field until success or explicit reset, so a failed protected attempt cannot silently retry without protection. The app never writes passwords to localStorage or sessionStorage. Other errors are inline, selections are retained, status errors offer a status-only retry, and missing jobs stop polling. The client never displays arbitrary server error strings or logs filenames, passwords, derived keys, session IDs, tokens, or return URLs.

## Important copy and protocol constraints

The file is uploaded in plaintext and processed on the server. The optional password is converted to a derived key in the browser; that key is sent to the server, as before. Do not describe this as local-only, offline, end-to-end encrypted, or durable backup.

The server's `files.expires_at` is the recovery deadline. When metadata is available, the result displays that exact timestamp in the viewer's local time. Downloading a ZIP, adding a password, or issuing a new download token does not extend the underlying file's expiry. Cleanup is scheduled, so deletion is not claimed to happen at an exact moment; retained keys and backups have separate operational considerations documented in [security-update.md](security-update.md).

Return links contain access to the job result. They are labeled private and temporary, are not logged or written to localStorage/sessionStorage, and may fail after a server restart because sessions are held in memory. Their URLs may remain in browser history or be synced by the browser. Existing `?session=` encoding links remain supported. There is no new server-side cancellation or durable job-resume feature.

Passwords retain the existing client's whitespace-trimming behavior for compatibility. PNG and ZIP extension validation is case-insensitive in the client; a single ZIP's extension is normalized on upload for the existing server route.

## Review and testing

See [testing.md](testing.md). Use synthetic files in an isolated development instance. Do not use production data to test the interface.

Check desktop and 320/390 px mobile layouts, keyboard file selection, tab arrow keys, visible focus, live status/error announcements, password Show/Hide, task switching during upload, Back/Forward, repeated submits, reset during upload/poll/derivation, network interruption, wrong-password retry, incomplete image sets, expired return links and explicit downloads. The progress bar is indeterminate when no measured progress is available; it never invents time-based percentages.
