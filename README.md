# InPlainSight

Post-quantum steganographic file encryption service that converts files into encrypted PNG images.

## Features

- **Post-Quantum Encryption**: Uses ML-KEM (Kyber) for quantum-resistant security
- **Steganographic Encoding**: Embeds encrypted data into PNG images
- **Large File Support**: Handles files up to 10GB
- **Automatic Cleanup**: Files automatically deleted after 1 hour
- **User-Friendly Interface**: Drag-and-drop upload with real-time progress tracking
- **Flexible Download**: Download as ZIP bundle or individual PNGs

## How It Works

1. **Encode**: Upload any file → Split into 3MB chunks → Encrypt with Kyber → Encode into PNGs
2. **Decode**: Upload PNGs (or ZIP) → Decrypt → Reconstruct original file

## Installation

```bash
cd /home/maestro/inplainsight
npm install
```

## Development

Run the server manually:

```bash
npm start
# Server runs on http://localhost:3008
```

## Production Deployment

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

## Nginx Configuration

Add to `/etc/nginx/sites-enabled/vincentmossman.com`:

```nginx
# InPlainSight - proxy to port 3008 with path rewriting
location /inplainsight/ {
    client_max_body_size 10G;  # Support up to 10GB uploads
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

## Access

- **Production**: https://vincentmossman.com/inplainsight/
- **Local Dev**: http://localhost:3008

## Security update and regression tests

Read [the compatibility and rollout review](docs/security-update.md) before any deployment or database upgrade. It explains historical-file recovery caveats and evidence preservation. Run `npm ci` and `npm test` in an isolated checkout; the HTTP regression test needs local port 3008 free. Tests use synthetic data only.

## Security

- Encryption keys stored server-side only (never exposed to users)
- Keys stored in SQLite database with file-level permissions
- The service schedules expiry cleanup; key retention and historical backups should be verified separately
- Post-quantum encryption protects against future quantum computers

## Technical Details

### Encryption Stack
- **Key Encapsulation**: ML-KEM-768 (NIST standardized Kyber)
- **Symmetric Encryption**: AES-256-GCM
- **Data Encoding**: Binary → Greyscale PNG pixels

### PNG Structure
- First 32 pixels: Metadata (magic number, file ID, chunk index, total count)
- Remaining pixels: Encrypted data (one byte per greyscale pixel value)
- Final pixel: Transparent (prevents compression)

### Database Schema
- `files`: File metadata and expiration timestamps
- `encryption_keys`: Kyber public/secret key pairs
- `download_tokens`: Temporary download URLs (1-hour expiration)

## Project Structure

```
inplainsight/
├── server/
│   ├── server.js           # Express server and API routes
│   ├── encryption.js       # Kyber encryption/decryption
│   ├── pngEncoder.js       # PNG encoding/decoding
│   ├── fileProcessor.js    # File processing orchestration
│   └── cleanup.js          # Scheduled cleanup tasks
├── client/
│   ├── index.html          # Frontend UI
│   ├── styles.css          # Styling
│   └── app.js              # Frontend logic
├── database/
│   ├── schema.sql          # Database schema
│   ├── db.js               # Database initialization
│   └── inplainsight.db     # SQLite database (created at runtime)
└── temp/
    ├── uploads/            # Temporary uploaded files
    ├── processed/          # Generated PNGs
    └── downloads/          # ZIP bundles and reconstructed files
```

## Troubleshooting

### Server won't start
- Check port 3008 is available: `lsof -i :3008`
- Check logs: `journalctl -u inplainsight.service -n 50`

### Upload fails
- Verify nginx `client_max_body_size` is set to 10G
- Check disk space: `df -h`

### Files not being cleaned up
- Check cleanup scheduler logs in service journal
- Manually trigger cleanup: restart the service

## License

ISC

