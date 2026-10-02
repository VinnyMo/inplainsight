console.log('=== InPlainSight JS v7 Loading ===');

// Debug logging system
const debugOutput = document.getElementById('debug-output');
const clearDebugBtn = document.getElementById('clear-debug');

function debugLog(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.className = `debug-entry ${type}`;
    entry.innerHTML = `<span class="debug-timestamp">[${timestamp}]</span>${message}`;
    debugOutput.appendChild(entry);
    debugOutput.scrollTop = debugOutput.scrollHeight;

    // Also log to console
    console.log(`[DEBUG ${type}] ${message}`);
}

// Clear debug button
if (clearDebugBtn) {
    clearDebugBtn.addEventListener('click', () => {
        debugOutput.innerHTML = '';
    });
}

// Determine base path for API calls
// Extract directory path, removing any filename
const pathname = window.location.pathname;
const BASE_PATH = pathname.endsWith('/')
    ? pathname
    : pathname.substring(0, pathname.lastIndexOf('/') + 1);

debugLog(`App loaded. BASE_PATH: ${BASE_PATH}`, 'success');
debugLog(`User Agent: ${navigator.userAgent}`, 'info');
debugLog(`Platform: ${navigator.platform}`, 'info');

// Tab switching
const tabButtons = document.querySelectorAll('.tab-button');
const tabContents = document.querySelectorAll('.tab-content');

tabButtons.forEach(button => {
    button.addEventListener('click', () => {
        const tabName = button.dataset.tab;

        // Remove active class from all buttons and contents
        tabButtons.forEach(btn => btn.classList.remove('active'));
        tabContents.forEach(content => content.classList.remove('active'));

        // Add active class to clicked button and corresponding content
        button.classList.add('active');
        document.getElementById(`${tabName}-tab`).classList.add('active');
    });
});

// ==================== ENCODE TAB ====================

// PNG Size Slider
const pngSizeSlider = document.getElementById('png-size-slider');
const pngSizeValue = document.getElementById('png-size-value');
const encodePassword = document.getElementById('encode-password');

console.log('PNG Size Slider element:', pngSizeSlider);
console.log('Initial slider value:', pngSizeSlider?.value);

pngSizeSlider.addEventListener('input', (e) => {
    pngSizeValue.textContent = e.target.value;
    console.log('Slider changed to:', e.target.value);
});

const encodeUploadBox = document.getElementById('encode-upload-box');
const encodeFileInput = document.getElementById('encode-file-input');
const encodeSelectedFile = document.getElementById('encode-selected-file');
const encodeLinkSection = document.getElementById('encode-link-section');
const shareableLink = document.getElementById('shareable-link');
const copyLinkBtn = document.getElementById('copy-link-btn');
const encodeProgressSection = document.getElementById('encode-progress-section');
const encodeProgressFill = document.getElementById('encode-progress-fill');
const encodeProgressText = document.getElementById('encode-progress-text');
const encodeResultsSection = document.getElementById('encode-results-section');
const downloadZipBtn = document.getElementById('download-zip-btn');
const startNewBtn = document.getElementById('start-new-btn');
const pngGallery = document.getElementById('png-gallery');
const galleryGrid = document.getElementById('gallery-grid');
const pngCount = document.getElementById('png-count');

let currentEncodeFile = null;
let currentFileId = null;
let currentDownloadToken = null;
let currentSessionId = null;

// Copy link button
copyLinkBtn.addEventListener('click', () => {
    shareableLink.select();
    document.execCommand('copy');
    const originalText = copyLinkBtn.textContent;
    copyLinkBtn.textContent = 'Copied!';
    setTimeout(() => {
        copyLinkBtn.textContent = originalText;
    }, 2000);
});

// Click to upload
encodeUploadBox.addEventListener('click', () => {
    encodeFileInput.click();
});

// File selection
encodeFileInput.addEventListener('change', (e) => {
    debugLog(`File input changed, files count: ${e.target.files.length}`, 'info');
    if (e.target.files.length > 0) {
        currentEncodeFile = e.target.files[0];
        debugLog(`File selected: ${currentEncodeFile.name}`, 'info');
        debugLog(`File size: ${formatFileSize(currentEncodeFile.size)} (${currentEncodeFile.size} bytes)`, 'info');
        debugLog(`File type: ${currentEncodeFile.type || 'unknown'}`, 'info');
        debugLog(`Last modified: ${new Date(currentEncodeFile.lastModified).toLocaleString()}`, 'info');
        encodeSelectedFile.textContent = `Selected: ${currentEncodeFile.name} (${formatFileSize(currentEncodeFile.size)})`;
        debugLog('Calling uploadAndEncodeFile()', 'info');
        uploadAndEncodeFile();
    } else {
        debugLog('No files selected', 'error');
    }
});

// Drag and drop
encodeUploadBox.addEventListener('dragover', (e) => {
    e.preventDefault();
    encodeUploadBox.classList.add('drag-over');
});

encodeUploadBox.addEventListener('dragleave', () => {
    encodeUploadBox.classList.remove('drag-over');
});

encodeUploadBox.addEventListener('drop', (e) => {
    e.preventDefault();
    encodeUploadBox.classList.remove('drag-over');

    if (e.dataTransfer.files.length > 0) {
        currentEncodeFile = e.dataTransfer.files[0];
        encodeSelectedFile.textContent = `Selected: ${currentEncodeFile.name} (${formatFileSize(currentEncodeFile.size)})`;
        uploadAndEncodeFile();
    }
});

// Upload and encode file
async function uploadAndEncodeFile() {
    debugLog('=== UPLOAD STARTED ===', 'success');
    debugLog(`File: ${currentEncodeFile.name}`, 'info');
    debugLog(`Size: ${formatFileSize(currentEncodeFile.size)}`, 'info');
    debugLog(`Target PNG Size: ${pngSizeSlider.value} MB`, 'info');

    // Check for password protection
    const password = encodePassword.value.trim();
    const usePassword = password.length > 0;
    if (usePassword) {
        debugLog('Password protection ENABLED', 'success');
    } else {
        debugLog('No password - files will expire in 1 hour', 'info');
    }

    // Verify file is valid
    if (!currentEncodeFile || currentEncodeFile.size === 0) {
        debugLog('ERROR: File is invalid or empty!', 'error');
        alert('Selected file is invalid or empty. Please try again.');
        resetEncodeTab();
        return;
    }

    // Hide upload box, show progress
    encodeUploadBox.style.display = 'none';
    encodeSelectedFile.style.display = 'none';
    encodeLinkSection.style.display = 'none';
    encodeProgressSection.style.display = 'block';
    encodeResultsSection.style.display = 'none';

    const formData = new FormData();

    try {
        formData.append('file', currentEncodeFile);
        formData.append('targetPngSizeMB', pngSizeSlider.value);

        // If password is set, derive key and add to form data
        if (usePassword) {
            encodeProgressText.textContent = 'Deriving encryption key from password...';
            debugLog('Deriving key from password using PBKDF2...', 'info');

            // Generate random salt and IV
            const salt = window.crypto.getRandomValues(new Uint8Array(32));
            const iv = window.crypto.getRandomValues(new Uint8Array(12));

            // Derive key from password
            const derivedKey = await deriveKeyFromPassword(password, salt);

            // Export the derived key to send to server (for encrypting Kyber secret key)
            const exportedKey = await window.crypto.subtle.exportKey('raw', derivedKey);
            const derivedKeyBase64 = arrayToBase64(new Uint8Array(exportedKey));

            // Add password protection info to form data
            formData.append('passwordProtected', 'true');
            formData.append('salt', arrayToBase64(salt));
            formData.append('iv', arrayToBase64(iv));
            formData.append('derivedKey', derivedKeyBase64);

            debugLog('Key derived successfully. Salt and IV generated.', 'success');
            encodeProgressText.textContent = 'Uploading...';
        }

        debugLog('FormData created, file appended successfully', 'info');
    } catch (err) {
        debugLog(`ERROR creating FormData: ${err.message}`, 'error');
        alert('Error preparing file for upload. Please try again.');
        resetEncodeTab();
        return;
    }

    const xhr = new XMLHttpRequest();
    debugLog('XMLHttpRequest created', 'info');

    // Set timeout to 2 hours (matches server timeout)
    xhr.timeout = 2 * 60 * 60 * 1000;
    debugLog('XHR timeout set to 2 hours', 'info');

    // Safari upload progress workaround
    // Safari often doesn't fire upload.progress events for large files
    let uploadStartTime = Date.now();
    let progressCheckInterval = null;
    let lastProgressEvent = false;
    let safariProgressCounter = 0;

    // Track upload progress
    xhr.upload.addEventListener('progress', (e) => {
        lastProgressEvent = true;
        clearInterval(progressCheckInterval); // Stop workaround if real progress events work

        if (e.lengthComputable) {
            const percentComplete = (e.loaded / e.total) * 100;
            encodeProgressFill.style.width = `${percentComplete}%`;
            encodeProgressText.textContent = `Uploading... ${Math.round(percentComplete)}%`;
            if (percentComplete % 10 === 0 || percentComplete === 100) {
                debugLog(`Upload progress: ${Math.round(percentComplete)}% (${e.loaded}/${e.total} bytes)`, 'info');
            }
        } else {
            debugLog('Upload progress: lengthComputable is false', 'error');
        }
    });

    // Workaround for Safari not firing progress events
    xhr.upload.addEventListener('loadstart', () => {
        debugLog('Upload.loadstart fired - starting Safari progress workaround', 'info');

        // Poll every 2 seconds to show upload is still happening
        progressCheckInterval = setInterval(() => {
            if (!lastProgressEvent) {
                safariProgressCounter++;
                const elapsed = Math.floor((Date.now() - uploadStartTime) / 1000);
                const speed = (currentEncodeFile.size / elapsed / 1024 / 1024).toFixed(2);

                encodeProgressText.textContent = `Uploading... (${elapsed}s elapsed, Safari progress mode)`;

                // Animate progress bar to show activity (fake progress based on time)
                const estimatedProgress = Math.min(95, (elapsed / 120) * 100); // Assume ~2min for full upload, max 95%
                encodeProgressFill.style.width = `${estimatedProgress}%`;

                // Log XHR state
                const readyStateNames = ['UNSENT', 'OPENED', 'HEADERS_RECEIVED', 'LOADING', 'DONE'];
                const stateName = readyStateNames[xhr.readyState] || 'UNKNOWN';

                if (safariProgressCounter % 5 === 0) {
                    debugLog(`Upload still in progress... ${elapsed}s elapsed, XHR state: ${stateName} (${xhr.readyState})`, 'info');
                }
            }
        }, 2000);
    });

    // Handle upload completion
    xhr.addEventListener('load', () => {
        clearInterval(progressCheckInterval); // Stop Safari workaround
        debugLog(`XHR load event fired. Status: ${xhr.status}`, 'info');

        if (xhr.status === 200) {
            debugLog('Upload successful! Response received', 'success');
            const response = JSON.parse(xhr.responseText);
            currentSessionId = response.sessionId;
            debugLog(`Session ID: ${currentSessionId}`, 'info');

            // Show shareable link
            const shareUrl = `${window.location.origin}${BASE_PATH}?session=${currentSessionId}`;
            shareableLink.value = shareUrl;
            encodeLinkSection.style.display = 'block';

            // Start polling for processing progress
            encodeProgressText.textContent = 'Upload complete! Processing...';
            encodeProgressFill.style.width = '100%';
            debugLog('Starting progress polling', 'info');
            pollProgress(currentSessionId, 'encode');
        } else {
            debugLog(`Upload error! Status: ${xhr.status} ${xhr.statusText}`, 'error');
            debugLog(`Response: ${xhr.responseText}`, 'error');
            alert('Error uploading file. Please try again.');
            resetEncodeTab();
        }
    });

    xhr.addEventListener('error', (e) => {
        clearInterval(progressCheckInterval);
        debugLog('XHR error event fired', 'error');
        debugLog(`Error details: ${JSON.stringify(e)}`, 'error');
        debugLog(`ReadyState: ${xhr.readyState}, Status: ${xhr.status}`, 'error');
        alert('Network error during upload. Please check your connection and try again.');
        resetEncodeTab();
    });

    xhr.addEventListener('timeout', () => {
        clearInterval(progressCheckInterval);
        debugLog('XHR timeout event fired after 2 hours', 'error');
        alert('Upload timed out. This file may be too large or your connection too slow. Please try again.');
        resetEncodeTab();
    });

    xhr.addEventListener('loadstart', () => {
        debugLog('XHR loadstart event fired - upload beginning', 'info');
    });

    xhr.addEventListener('loadend', () => {
        clearInterval(progressCheckInterval);
        const elapsed = Math.floor((Date.now() - uploadStartTime) / 1000);
        debugLog(`XHR loadend event fired - upload finished after ${elapsed}s`, 'info');
    });

    xhr.addEventListener('abort', () => {
        clearInterval(progressCheckInterval);
        debugLog('XHR abort event fired - upload cancelled', 'error');
    });

    const url = `${BASE_PATH}api/encode`;
    debugLog(`Opening XHR POST to: ${url}`, 'info');
    xhr.open('POST', url, true);
    debugLog('Sending FormData...', 'info');

    try {
        xhr.send(formData);
        debugLog('xhr.send() called successfully', 'success');
    } catch (err) {
        debugLog(`Error calling xhr.send(): ${err.message}`, 'error');
        debugLog(`Error stack: ${err.stack}`, 'error');
    }
}

// Poll for progress
async function pollProgress(sessionId, type) {
    const progressFill = type === 'encode' ? encodeProgressFill : decodeProgressFill;
    const progressText = type === 'encode' ? encodeProgressText : decodeProgressText;

    const interval = setInterval(async () => {
        try {
            const response = await fetch(`${BASE_PATH}api/progress/${sessionId}`);
            const progress = await response.json();

            // Update progress bar
            progressFill.style.width = `${progress.progress}%`;

            // Update text
            const stageTexts = {
                'starting': 'Starting...',
                'splitting': 'Splitting file into chunks...',
                'encrypting': 'Encrypting with post-quantum cryptography...',
                'generating': `Generating PNG images... ${Math.round(progress.progress)}%`,
                'zipping': 'Creating ZIP bundle...',
                'reading': `Reading PNG images... ${Math.round(progress.progress)}%`,
                'decrypting': `Decrypting and reconstructing... ${Math.round(progress.progress)}%`,
                'complete': 'Complete!',
                'incomplete': 'Incomplete upload',
                'password_required': 'Password required',
                'error': 'Error occurred'
            };

            progressText.textContent = stageTexts[progress.stage] || 'Processing...';

            // Check if complete
            if (progress.stage === 'complete') {
                clearInterval(interval);

                if (type === 'encode') {
                    showEncodeResults(progress);
                } else {
                    showDecodeResults(progress);
                }
            } else if (progress.stage === 'password_required') {
                clearInterval(interval);
                debugLog('Password-protected PNGs detected', 'info');
                // Store salt and IV for password derivation
                passwordSalt = progress.salt;
                passwordIV = progress.iv;
                debugLog(`Salt and IV received from server`, 'info');
                showPasswordModal();
            } else if (progress.stage === 'incomplete') {
                clearInterval(interval);
                showDecodeError(progress);
            } else if (progress.stage === 'error') {
                clearInterval(interval);
                alert(`Error: ${progress.error}`);
                if (type === 'encode') {
                    resetEncodeTab();
                } else {
                    resetDecodeTab();
                }
            }
        } catch (err) {
            console.error('Error polling progress:', err);
        }
    }, 500); // Poll every 500ms
}

// Show encode results
async function showEncodeResults(progress) {
    currentFileId = progress.fileId;
    currentDownloadToken = progress.downloadToken;

    encodeProgressSection.style.display = 'none';
    encodeResultsSection.style.display = 'block';

    pngCount.textContent = progress.pngCount;

    // Fetch file metadata to get PNG list
    const response = await fetch(`${BASE_PATH}api/file/${currentFileId}`);
    const fileData = await response.json();

    // Populate gallery
    galleryGrid.innerHTML = '';
    for (let i = 0; i < fileData.pngCount; i++) {
        const pngItem = createPngItem(currentFileId, i);
        galleryGrid.appendChild(pngItem);
    }
}

// Create PNG gallery item
function createPngItem(fileId, index) {
    const div = document.createElement('div');
    div.className = 'png-item';

    // Create container for image with loading spinner
    const imgContainer = document.createElement('div');
    imgContainer.className = 'png-preview-container';

    // Create loading spinner
    const spinner = document.createElement('div');
    spinner.className = 'png-loading-spinner';

    // Create image
    const img = document.createElement('img');
    img.className = 'png-preview';
    img.src = `${BASE_PATH}api/png/${fileId}/${index}`;

    // Hide spinner and show image when loaded
    img.onload = () => {
        spinner.classList.add('hidden');
        img.classList.add('loaded');
    };

    // Handle error
    img.onerror = () => {
        spinner.classList.add('hidden');
        img.classList.add('loaded');
        console.error(`Failed to load image ${index}`);
    };

    imgContainer.appendChild(spinner);
    imgContainer.appendChild(img);

    const p = document.createElement('p');
    p.textContent = `Image ${index + 1}`;

    const btn = document.createElement('button');
    btn.className = 'png-download-btn';
    btn.textContent = 'Download';
    btn.onclick = () => {
        window.location.href = `${BASE_PATH}api/png/${fileId}/${index}`;
    };

    div.appendChild(imgContainer);
    div.appendChild(p);
    div.appendChild(btn);

    return div;
}

// Download ZIP
downloadZipBtn.addEventListener('click', () => {
    window.location.href = `${BASE_PATH}api/download/${currentDownloadToken}`;
});

// Start new encode
startNewBtn.addEventListener('click', () => {
    resetEncodeTab();
});

function resetEncodeTab() {
    encodeUploadBox.style.display = 'block';
    encodeSelectedFile.style.display = 'block';
    encodeSelectedFile.textContent = '';
    encodeLinkSection.style.display = 'none';
    encodeProgressSection.style.display = 'none';
    encodeResultsSection.style.display = 'none';
    encodeFileInput.value = '';

    // Reset progress bar
    encodeProgressFill.style.width = '0%';
    encodeProgressText.textContent = 'Preparing...';

    // Clear gallery
    galleryGrid.innerHTML = '';
    pngCount.textContent = '0';

    // Clear state variables
    currentEncodeFile = null;
    currentFileId = null;
    currentDownloadToken = null;
    currentSessionId = null;

    // Clear URL parameters
    window.history.replaceState({}, document.title, window.location.pathname);
}

// ==================== DECODE TAB ====================

const decodeUploadBox = document.getElementById('decode-upload-box');
const decodeFileInput = document.getElementById('decode-file-input');
const decodeSelectedFile = document.getElementById('decode-selected-file');
const decodeProgressSection = document.getElementById('decode-progress-section');
const decodeProgressFill = document.getElementById('decode-progress-fill');
const decodeProgressText = document.getElementById('decode-progress-text');
const decodeResultsSection = document.getElementById('decode-results-section');
const decodeErrorSection = document.getElementById('decode-error-section');
const downloadOriginalBtn = document.getElementById('download-original-btn');
const decodeNewBtn = document.getElementById('decode-new-btn');
const retryDecodeBtn = document.getElementById('retry-decode-btn');
const originalFilename = document.getElementById('original-filename');
const errorMessage = document.getElementById('error-message');

// Password modal
const passwordModal = document.getElementById('password-modal');
const decodePassword = document.getElementById('decode-password');
const passwordSubmitBtn = document.getElementById('password-submit-btn');
const passwordCancelBtn = document.getElementById('password-cancel-btn');

let currentDecodeFiles = null;
let currentDecodeToken = null;
let passwordSalt = null;
let passwordIV = null;

// Click to upload
decodeUploadBox.addEventListener('click', () => {
    decodeFileInput.click();
});

// File selection
decodeFileInput.addEventListener('change', (e) => {
    debugLog(`Decode file input changed, files count: ${e.target.files.length}`, 'info');
    if (e.target.files.length > 0) {
        currentDecodeFiles = e.target.files;
        const fileCount = currentDecodeFiles.length;
        const isZip = fileCount === 1 && currentDecodeFiles[0].name.endsWith('.zip');

        if (isZip) {
            debugLog(`ZIP file selected: ${currentDecodeFiles[0].name}`, 'info');
            decodeSelectedFile.textContent = `Selected: ${currentDecodeFiles[0].name}`;
        } else {
            debugLog(`${fileCount} PNG files selected`, 'info');
            decodeSelectedFile.textContent = `Selected: ${fileCount} PNG file(s)`;
        }

        debugLog('Calling uploadAndDecodeFiles()', 'info');
        uploadAndDecodeFiles();
    } else {
        debugLog('No decode files selected', 'error');
    }
});

// Drag and drop
decodeUploadBox.addEventListener('dragover', (e) => {
    e.preventDefault();
    decodeUploadBox.classList.add('drag-over');
});

decodeUploadBox.addEventListener('dragleave', () => {
    decodeUploadBox.classList.remove('drag-over');
});

decodeUploadBox.addEventListener('drop', (e) => {
    e.preventDefault();
    decodeUploadBox.classList.remove('drag-over');

    if (e.dataTransfer.files.length > 0) {
        currentDecodeFiles = e.dataTransfer.files;
        const fileCount = currentDecodeFiles.length;
        const isZip = fileCount === 1 && currentDecodeFiles[0].name.endsWith('.zip');

        if (isZip) {
            decodeSelectedFile.textContent = `Selected: ${currentDecodeFiles[0].name}`;
        } else {
            decodeSelectedFile.textContent = `Selected: ${fileCount} PNG file(s)`;
        }

        uploadAndDecodeFiles();
    }
});

// Upload and decode files
function uploadAndDecodeFiles() {
    debugLog('=== DECODE UPLOAD STARTED ===', 'success');
    debugLog(`Number of files: ${currentDecodeFiles.length}`, 'info');

    // Hide upload box, show progress
    decodeUploadBox.style.display = 'none';
    decodeSelectedFile.style.display = 'none';
    decodeProgressSection.style.display = 'block';
    decodeResultsSection.style.display = 'none';
    decodeErrorSection.style.display = 'none';

    const formData = new FormData();

    try {
        for (let i = 0; i < currentDecodeFiles.length; i++) {
            formData.append('files', currentDecodeFiles[i]);
            debugLog(`Added file ${i + 1}: ${currentDecodeFiles[i].name} (${formatFileSize(currentDecodeFiles[i].size)})`, 'info');
        }
        debugLog('FormData created successfully', 'info');
    } catch (err) {
        debugLog(`ERROR creating FormData: ${err.message}`, 'error');
        alert('Error preparing files for upload. Please try again.');
        resetDecodeTab();
        return;
    }

    const xhr = new XMLHttpRequest();
    debugLog('XMLHttpRequest created for decode', 'info');

    // Set timeout to 2 hours (matches server timeout)
    xhr.timeout = 2 * 60 * 60 * 1000;
    debugLog('XHR timeout set to 2 hours', 'info');

    // Safari upload progress workaround for decode
    let uploadStartTime = Date.now();
    let progressCheckInterval = null;
    let lastProgressEvent = false;
    let safariProgressCounter = 0;

    // Track upload progress
    xhr.upload.addEventListener('progress', (e) => {
        lastProgressEvent = true;
        clearInterval(progressCheckInterval);

        if (e.lengthComputable) {
            const percentComplete = (e.loaded / e.total) * 100;
            decodeProgressFill.style.width = `${percentComplete}%`;
            decodeProgressText.textContent = `Uploading... ${Math.round(percentComplete)}%`;
            if (percentComplete % 10 === 0 || percentComplete === 100) {
                debugLog(`Decode upload progress: ${Math.round(percentComplete)}%`, 'info');
            }
        } else {
            debugLog('Decode upload progress: lengthComputable is false', 'error');
        }
    });

    // Workaround for Safari not firing progress events
    xhr.upload.addEventListener('loadstart', () => {
        debugLog('Decode upload.loadstart fired - starting Safari progress workaround', 'info');

        progressCheckInterval = setInterval(() => {
            if (!lastProgressEvent) {
                safariProgressCounter++;
                const elapsed = Math.floor((Date.now() - uploadStartTime) / 1000);

                decodeProgressText.textContent = `Uploading... (${elapsed}s elapsed, Safari progress mode)`;
                const estimatedProgress = Math.min(95, (elapsed / 60) * 100);
                decodeProgressFill.style.width = `${estimatedProgress}%`;

                const readyStateNames = ['UNSENT', 'OPENED', 'HEADERS_RECEIVED', 'LOADING', 'DONE'];
                const stateName = readyStateNames[xhr.readyState] || 'UNKNOWN';

                if (safariProgressCounter % 5 === 0) {
                    debugLog(`Decode upload in progress... ${elapsed}s elapsed, XHR state: ${stateName}`, 'info');
                }
            }
        }, 2000);
    });

    // Handle upload completion
    xhr.addEventListener('load', () => {
        clearInterval(progressCheckInterval);
        debugLog(`Decode XHR load event fired. Status: ${xhr.status}`, 'info');

        if (xhr.status === 200) {
            debugLog('Decode upload successful!', 'success');
            const response = JSON.parse(xhr.responseText);
            const sessionId = response.sessionId;
            debugLog(`Decode session ID: ${sessionId}`, 'info');

            // Start polling for processing progress
            decodeProgressText.textContent = 'Upload complete! Processing...';
            decodeProgressFill.style.width = '100%';
            debugLog('Starting decode progress polling', 'info');
            pollProgress(sessionId, 'decode');
        } else {
            debugLog(`Decode upload error! Status: ${xhr.status} ${xhr.statusText}`, 'error');
            debugLog(`Response: ${xhr.responseText}`, 'error');
            alert('Error uploading files. Please try again.');
            resetDecodeTab();
        }
    });

    xhr.addEventListener('error', (e) => {
        clearInterval(progressCheckInterval);
        debugLog('Decode XHR error event fired', 'error');
        debugLog(`ReadyState: ${xhr.readyState}, Status: ${xhr.status}`, 'error');
        alert('Network error during upload. Please check your connection and try again.');
        resetDecodeTab();
    });

    xhr.addEventListener('timeout', () => {
        clearInterval(progressCheckInterval);
        debugLog('Decode XHR timeout event fired', 'error');
        alert('Upload timed out. Files may be too large or your connection too slow. Please try again.');
        resetDecodeTab();
    });

    xhr.addEventListener('loadstart', () => {
        debugLog('Decode XHR loadstart event fired', 'info');
    });

    xhr.addEventListener('loadend', () => {
        clearInterval(progressCheckInterval);
        const elapsed = Math.floor((Date.now() - uploadStartTime) / 1000);
        debugLog(`Decode XHR loadend event fired after ${elapsed}s`, 'info');
    });

    const url = `${BASE_PATH}api/decode`;
    debugLog(`Opening decode XHR POST to: ${url}`, 'info');
    xhr.open('POST', url, true);
    debugLog('Sending decode FormData...', 'info');

    try {
        xhr.send(formData);
        debugLog('Decode xhr.send() called successfully', 'success');
    } catch (err) {
        debugLog(`Error calling decode xhr.send(): ${err.message}`, 'error');
    }
}

// Show decode results
function showDecodeResults(progress) {
    currentDecodeToken = progress.downloadToken;

    decodeProgressSection.style.display = 'none';
    decodeResultsSection.style.display = 'block';

    originalFilename.textContent = `Original file: ${progress.originalFilename}`;
}

// Show decode error
function showDecodeError(progress) {
    decodeProgressSection.style.display = 'none';
    decodeErrorSection.style.display = 'block';

    errorMessage.textContent = `Missing ${progress.missingCount} out of ${progress.totalCount} images. Please upload all ${progress.totalCount} PNG files to reconstruct the original file.`;
}

// Download original
downloadOriginalBtn.addEventListener('click', () => {
    window.location.href = `${BASE_PATH}api/download/${currentDecodeToken}`;
});

// Decode new file
decodeNewBtn.addEventListener('click', () => {
    resetDecodeTab();
});

// Retry decode
retryDecodeBtn.addEventListener('click', () => {
    resetDecodeTab();
});

function resetDecodeTab() {
    decodeUploadBox.style.display = 'block';
    decodeSelectedFile.style.display = 'block';
    decodeSelectedFile.textContent = '';
    decodeProgressSection.style.display = 'none';
    decodeResultsSection.style.display = 'none';
    decodeErrorSection.style.display = 'none';
    decodeFileInput.value = '';

    // Reset progress bar
    decodeProgressFill.style.width = '0%';
    decodeProgressText.textContent = 'Preparing...';

    // Clear filename display
    originalFilename.textContent = '';

    // Clear state variables
    currentDecodeFiles = null;
    currentDecodeToken = null;
}

// ==================== PASSWORD MODAL ====================

function showPasswordModal() {
    debugLog('Showing password modal', 'info');
    passwordModal.style.display = 'flex';
    decodePassword.value = '';
    decodePassword.focus();
}

function hidePasswordModal() {
    passwordModal.style.display = 'none';
    decodePassword.value = '';
}

// Password submit
passwordSubmitBtn.addEventListener('click', async () => {
    const password = decodePassword.value.trim();

    if (!password) {
        alert('Please enter a password');
        return;
    }

    debugLog('Password entered, deriving key...', 'info');
    hidePasswordModal();

    // Show progress
    decodeProgressSection.style.display = 'block';
    decodeProgressText.textContent = 'Deriving encryption key from password...';
    decodeProgressFill.style.width = '10%';

    try {
        // Need to get salt and IV from first PNG
        const firstFileReader = new FileReader();
        firstFileReader.onload = async (e) => {
            // For now, we'll get salt/IV from the server response
            // The server already has it in the database
            await uploadAndDecodeWithPassword(password);
        };

        if (currentDecodeFiles[0] instanceof File) {
            firstFileReader.readAsArrayBuffer(currentDecodeFiles[0]);
        } else {
            await uploadAndDecodeWithPassword(password);
        }
    } catch (err) {
        debugLog(`Error deriving key: ${err.message}`, 'error');
        alert('Error deriving encryption key. Please try again.');
        resetDecodeTab();
    }
});

// Password cancel
passwordCancelBtn.addEventListener('click', () => {
    debugLog('Password entry cancelled', 'info');
    hidePasswordModal();
    resetDecodeTab();
});

// Allow Enter key to submit password
decodePassword.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        passwordSubmitBtn.click();
    }
});

// Upload and decode with password
async function uploadAndDecodeWithPassword(password) {
    debugLog('=== DECODE WITH PASSWORD ===', 'success');
    debugLog('Deriving key from password...', 'info');

    try {
        // We need to get the salt from the database
        // For simplicity, we'll derive a key and send it to the server
        // The server will use it to decrypt the Kyber secret key
        // First, we need to read one PNG to get the file ID and fetch metadata

        // Read first PNG to get file info
        const firstPngFile = currentDecodeFiles[0];
        const arrayBuffer = await firstPngFile.arrayBuffer();

        // Send a request to get the file metadata with salt/IV
        // For now, we'll use a placeholder salt (server has the real one)
        // Actually, we need a different approach - let's send the password-derived key to server

        // Generate a deterministic salt from the PNG data (first 32 bytes of file ID hash)
        // Actually, server stores the salt, so we need to fetch it first
        // Let's use a simplified approach: fetch file metadata first

        // Note: We need to use the SAME salt that was used during encryption
        // The server will fetch the salt from the database and use it to decrypt
        // So we derive the key with the original salt (stored in DB)
        // For simplicity, server handles the salt lookup

        // Actually, we need to derive with the correct salt
        // Let's fetch it from server first by uploading one PNG temporarily
        // Or better: just send the password-derived key using the stored salt

        // Simpler approach: We send the password to server (NO - violates requirement)
        // Better: Upload files first, server tells us the salt, we derive key, re-upload with key

        // Best approach: Derive key on client using salt from first PNG upload
        // But that requires round-trip. Let's use a hybrid approach:
        // Client derives key with a KNOWN salt derivation from password itself

        // Actually, rethinking: salt should be the same for encode/decode
        // Client sends salt during encode, stores in DB
        // Client must use SAME salt during decode
        // So client must fetch salt first from server

        // Simplified: Just upload files and password-based key
        // Server has the salt and will re-derive properly

        // Upload files and send derived key based on salt from server
        const formData = new FormData();

        for (let i = 0; i < currentDecodeFiles.length; i++) {
            formData.append('files', currentDecodeFiles[i]);
        }

        // We'll send a password-derived key
        // Server will re-derive using the stored salt and compare
        // Or better: server sends us the salt, we derive, send back derived key

        // For now: use password as-is to derive key (server re-derives with stored salt)
        // This requires server to accept password (violates no-plaintext rule)

        // Correct approach: Fetch salt from server first
        // Let me implement a two-step process
        decodeProgressText.textContent = 'Fetching encryption parameters...';

        // We'll just append password to form and let server handle derivation
        // NO - violates security requirement

        // Final approach: Upload once, server checks password protection, returns salt
        // Client derives key with salt, re-uploads with derived key
        // For MVP: send password (we'll improve this later)

        // Actually let's just do it right: derive key with same salt from encoding
        // The salt was sent during encoding and stored in DB
        // We can derive the key using that same salt
        // Server will use the salt from DB to decrypt

        // Since server has salt and will use it, we just need to derive with same salt
        // But client doesn't know the salt yet!
        // Solution: Encode salt in PNG metadata or fetch from server

        // Quick solution: Fetch file metadata from server to get salt
        // This requires knowing file ID, which we can get from PNG

        // For now, use a deterministic salt from password for testing
        // Server will re-derive using stored salt (won't match - need to fix)

        // Let me use the proper solution: fetch salt from server
        // Server endpoint added above returns salt for password-protected files

        // Use the salt from server (stored during encoding)
        if (!passwordSalt) {
            throw new Error('Salt not available from server');
        }

        const saltArray = base64ToArray(passwordSalt);

        debugLog(`Using salt from server (${saltArray.length} bytes)`, 'info');
        debugLog('Deriving encryption key with PBKDF2 (this may take a moment)...', 'info');
        decodeProgressText.textContent = 'Deriving encryption key (this may take 10-30 seconds)...';

        const derivedKey = await deriveKeyFromPassword(password, saltArray);

        // Export the derived key
        const exportedKey = await window.crypto.subtle.exportKey('raw', derivedKey);
        const derivedKeyBase64 = arrayToBase64(new Uint8Array(exportedKey));

        formData.append('derivedKey', derivedKeyBase64);

        debugLog('Key derived, uploading files...', 'success');
        decodeProgressText.textContent = 'Uploading files...';
        decodeProgressFill.style.width = '20%';

        // Upload with password
        const xhr = new XMLHttpRequest();
        xhr.timeout = 2 * 60 * 60 * 1000;

        // Track upload progress
        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
                const percentComplete = 20 + ((e.loaded / e.total) * 30); // 20-50%
                decodeProgressFill.style.width = `${percentComplete}%`;
                decodeProgressText.textContent = `Uploading... ${Math.round(percentComplete - 20)}%`;
            }
        });

        xhr.addEventListener('load', () => {
            if (xhr.status === 200) {
                debugLog('Upload successful, processing...', 'success');
                const response = JSON.parse(xhr.responseText);
                const sessionId = response.sessionId;

                decodeProgressText.textContent = 'Processing...';
                decodeProgressFill.style.width = '50%';
                pollProgress(sessionId, 'decode');
            } else {
                debugLog(`Upload error: ${xhr.status}`, 'error');
                alert('Error uploading files. Please try again.');
                resetDecodeTab();
            }
        });

        xhr.addEventListener('error', () => {
            debugLog('Upload network error', 'error');
            alert('Network error. Please try again.');
            resetDecodeTab();
        });

        const url = `${BASE_PATH}api/decode-with-password`;
        xhr.open('POST', url, true);
        xhr.send(formData);

    } catch (err) {
        debugLog(`Error: ${err.message}`, 'error');
        alert(`Error: ${err.message}`);
        resetDecodeTab();
    }
}

// ==================== UTILITIES ====================

function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ==================== SESSION RESUMPTION ====================

// Check for session parameter in URL on page load
window.addEventListener('DOMContentLoaded', () => {
    const urlParams = new URLSearchParams(window.location.search);
    const sessionId = urlParams.get('session');

    if (sessionId) {
        // Resume session
        currentSessionId = sessionId;

        // Show shareable link
        const shareUrl = `${window.location.origin}${BASE_PATH}?session=${sessionId}`;
        shareableLink.value = shareUrl;
        encodeLinkSection.style.display = 'block';

        // Hide upload box
        encodeUploadBox.style.display = 'none';
        encodeSelectedFile.style.display = 'none';

        // Show progress section
        encodeProgressSection.style.display = 'block';
        encodeProgressText.textContent = 'Checking status...';

        // Start polling
        pollProgress(sessionId, 'encode');
    }
});
