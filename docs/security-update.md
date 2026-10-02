# Password protection compatibility and rollout review

This patch is intended for isolated review and testing. It does not merge or deploy itself, inspect production logs, or prove whether anyone accessed data.

## Changes

- Both decode endpoints resolve the complete PNG set to exactly one database row before choosing a key. The database's protection flag and wrapper fields are authoritative. Clearing, changing, or setting the PNG's advisory flag cannot disable or enable password protection.
- Protected rows must unwrap their stored Kyber secret key with AES-256-GCM and a valid password-derived key. Authentication failure, malformed metadata, and missing wrappers fail closed. Historical plaintext keys are never a fallback for protected records.
- New protected uploads keep an empty BLOB in the legacy `secret_key NOT NULL` column and retain the existing password-wrapped key format. New unprotected uploads keep their ordinary key. No existing keys or encrypted files are rewritten, cleared, deleted, or rotated by this patch.
- A shared, transactional, additive schema upgrade runs before prepared statements on startup and through `node database/migrate.js`. It adds only missing password-related columns and is safe to repeat. No destructive data migration is included.
- Request logging records application route templates, methods, and numeric status codes. It omits bodies, derived keys, raw URLs/tokens, headers, filenames, and raw request errors. Newly uploaded files receive random local filenames. Debug-panel output uses text nodes, so filename markup is displayed literally.
- The browser's explanation now accurately states that password derivation occurs locally and the derived key is sent to the server. HTTPS is required: the derived key is sensitive and can unlock its corresponding wrapped key.

## Compatibility and recovery caveats

The PNG and encrypted-key formats are unchanged. Original pre-password schemas gain default unprotected metadata; their plaintext-key records remain readable. Historical protected records with their salt (32 bytes), IV (12 bytes), valid wrapped key, and correct password remain readable, including PNGs whose advisory flag was changed. Existing plaintext key bytes remain untouched.

Any password wrapper field on a row is treated conservatively as protection, even if its protection flag is zero or NULL. A protected/inconsistent row missing a valid wrapper is intentionally blocked. Preserve its database and artifacts for a separately authorized recovery review; do not reset the flag, remove metadata, or silently use the plaintext key. This patch cannot establish whether such rows exist in production.

Legacy PNGs carry only a 32-bit file-ID hash. Multiple matching rows are rejected instead of selecting an arbitrary row. Mixed-file sets, duplicate/out-of-range indexes, conflicting chunk counts, truncated payloads, and reconstructed-size mismatches are rejected. Valid chunks may be uploaded in any order. This does not redesign or cryptographically authenticate legacy header fields; a versioned format upgrade is outside this patch.

Normal startup still schedules the application's existing expiry cleanup. The migration command alone does not start cleanup. Do not start the service against preserved incident evidence or an only copy of historical data. Existing plaintext keys, historical log contents, key-retention policy, backups, and deployment/proxy logging require separate review. This patch does not erase evidence or revoke already issued download tokens.

## Separately approved rollout checklist

1. Keep deployment separate from PR review. Before touching the running service, preserve a verified consistent SQLite backup (including committed WAL state), relevant PNGs and temporary artifacts, and logs with restricted access. Do not copy only an actively written main SQLite file or put any of these materials into GitHub.
2. On an isolated backup copy, check protected records for complete, valid wrapper metadata and verify representative authorized historical protected and unprotected files. If a wrapper is missing/corrupt or a hash is ambiguous, stop for a recovery decision. Never print keys, file contents, passwords, derived keys, or tokens into test output.
3. Use the reviewed exact commit and the locked dependencies. Run `npm ci` and `npm test` in an isolated checkout. Tests generate their own disposable database/files, copy source into a temporary directory, and briefly bind only `127.0.0.1:3008`; that port must be free. They never open the checkout's real runtime database.
4. After explicit deployment approval, apply the code through the established deployment process, ensure the configured temporary directories exist, and run the additive upgrade before allowing requests (normal startup also upgrades automatically). Do not run against the only preserved copy of evidence. Test correct-password and rejected-password behavior with fresh synthetic files, including the ordinary decode endpoint with cleared PNG flags, and verify request logs stay free of secrets.
5. Verify the updated frontend asset (`app-v2.js?v=14`) is served; account for any proxy/browser caching. Confirm the actual deployed commit and service health before restoring exposure. Keep backups/evidence restricted. Do not revert to the vulnerable decoder to resolve a compatibility error; stop traffic and review recovery instead.

## Test coverage and limits

`npm test` exercises real ML-KEM and AES-GCM, real Sharp PNG encoding/decoding, real SQLite upgrades, copied application HTTP endpoints, and a DOM text-rendering harness, using only synthetic data. It covers historical/new protected and unprotected round trips; correct/wrong keys; cleared/noncanonical PNG flags; wrapper authentication-tag corruption; inconsistent database protection; missing wrappers; mixed/reordered/duplicate/invalid/missing chunks; incorrect/colliding file identifiers; malformed PNG lengths; safe logs; and filename markup.

These are isolated regression tests, not a live exploit, penetration test, large-file/load test, full-browser UI review, production data audit, privileged log review, or deployment verification. No production database, private keys, uploaded files, or logs are required or included.
