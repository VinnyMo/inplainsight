# InPlainSight

A server-assisted experiment that turns a file into encrypted PNG images, then reconstructs the file from the complete image set.

[Try InPlainSight](https://vincentmossman.com/inplainsight/)

**Keep your original file.** Recovery needs both the PNGs and this server's retained file record and key material. Files are scheduled to expire after about an hour; downloading the images does not create an independent, long-term backup.

## Try the workflow

1. **Hide a file:** choose a file, review the optional password and image size, create the PNGs, and download the complete ZIP bundle
2. **Recover a file:** choose that ZIP or every PNG in the set, enter the password if needed, and download the reconstructed file

Use a small, non-sensitive test file first. The guided interface includes progress, retry and recovery states. Intermittent mobile Chrome file-picker behavior is tracked in [issue #3](https://github.com/VinnyMo/inplainsight/issues/3).

## Security and limits

- **Server-assisted processing:** the original file is uploaded to the server, which performs encryption and recovery. This is not end-to-end encryption.
- **Password protection:** the browser derives a key locally and sends that derived key to the server. The derived key is sensitive; use HTTPS outside local development. New password-protected records store a wrapped secret key.
- **Cryptography:** ML-KEM-768 establishes shared secrets and AES-256-GCM encrypts chunks. Using these primitives does not establish that the whole application is secure, audited, or “quantum-proof.”
- **PNG encoding:** encrypted bytes are represented as greyscale pixel values. Keep the PNGs unchanged; resizing, recompressing, or converting them can destroy recovery data.
- **Expiry:** the application assigns one-hour expiry times and schedules cleanup every 15 minutes, plus a startup pass. This is not a guarantee of exact deletion time or erasure from backups, logs, and historical key storage.
- **Size:** the upload middleware permits up to 10 GiB per file, but processing reads whole files into memory and creates additional buffers and images. That ceiling is not a tested large-file capacity guarantee.
- **Legacy format:** chunk headers are not fully bound into cryptographic authentication. The [security review](docs/security-update.md) documents remaining ordering, identity, historical-key, and recovery limitations.

This is an experimental project, not a place to entrust irreplaceable files or sensitive material. Read the security review before deploying, upgrading a database, or attempting historical recovery.

## Run locally

Use a current Node.js/npm installation compatible with the locked native dependencies (`better-sqlite3` and `sharp`). A native build toolchain may be needed if prebuilt packages are unavailable.

```sh
git clone https://github.com/VinnyMo/inplainsight.git
cd inplainsight
npm ci
mkdir -p temp/uploads temp/processed temp/downloads
npm start
```

Open [http://localhost:3008](http://localhost:3008). The server binds to the loopback interface. SQLite state is created locally, and startup applies additive schema upgrades and starts expiry cleanup.

**Use a fresh checkout and synthetic data.** Do not start this service against the only copy of an old database or preserved recovery evidence.

## Tests and documentation

```sh
npm test
```

The security/HTTP regression suite uses synthetic data in an isolated copy and needs local port 3008 free. Frontend state checks use a DOM model. The optional Playwright suite can report a skip when browser tooling is unavailable; a skip does not verify native file pickers, rendering, or downloads.

- [Testing guide](docs/testing.md): test commands, prerequisites, and verification limits
- [Security and compatibility review](docs/security-update.md): password enforcement, historical recovery, format caveats, and rollout safeguards
- [Guided workflow notes](docs/ux-overhaul.md): frontend behavior and review checklist

## Project layout

```text
client/index.html          Guided interface
client/app-v2.js           Served frontend workflow
client/crypto-utils.js     Browser-side password derivation
server/server.js           Express routes and download handling
server/encryption.js       ML-KEM-768 and AES-256-GCM
server/fileProcessor.js    File/chunk orchestration
server/pngEncoder.js       PNG encoding and decoding
server/keyProtection.js    Stored-key protection checks
server/cleanup.js          Scheduled expiry cleanup
database/                 SQLite schema and additive migrations
test/                     Security and interface regressions
temp/                     Runtime uploads, PNGs, ZIPs, and recovered files
```

## Deployment reference

The service file and nginx example below describe the existing deployment layout. Review paths, service user, permissions, storage, proxy limits, and TLS for your own host; they are not a general production-hardening recipe. The proxy's upload ceiling does not remove the application's memory limits. Follow the [rollout safeguards](docs/security-update.md#separately-approved-rollout-checklist) before changing a running instance.

### systemd example

1. Copy the systemd service file:
```bash
sudo cp inplainsight.service /etc/systemd/system/
```

2. Reload systemd and enable the service:
```bash
sudo systemctl daemon-reload
sudo systemctl enable inplainsight.service
sudo systemctl start inplainsight.service
```

3. Check status:
```bash
sudo systemctl status inplainsight.service
```

4. View logs:
```bash
journalctl -u inplainsight.service -f
```

### nginx example

Add to `/etc/nginx/sites-enabled/vincentmossman.com`:

```nginx
# InPlainSight - proxy to port 3008 with path rewriting
location /inplainsight/ {
    client_max_body_size 10G;  # Proxy ceiling only; not a tested processing guarantee
    proxy_pass http://localhost:3008/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_cache_bypass $http_upgrade;

    # Extended timeouts for large file uploads
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}

# Handle /inplainsight without trailing slash
location /inplainsight {
    return 301 $scheme://$host/inplainsight/;
}
```

Test and restart nginx:
```bash
sudo nginx -t
sudo systemctl restart nginx
```


## Troubleshooting

- **Server won't start:** check that port 3008 is free and the runtime directories are writable
- **Upload fails:** check available disk/RAM, native dependencies, and both application and proxy limits
- **Cleanup or recovery differs from expectations:** review service logs and the security guide; preserve relevant evidence before restarting, because startup schedules cleanup

## License

The package declares an ISC license.
