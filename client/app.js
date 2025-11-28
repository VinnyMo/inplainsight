// Determine base path for API calls
// Extract directory path, removing any filename
const pathname = window.location.pathname;
const BASE_PATH = pathname.endsWith('/')
    ? pathname
    : pathname.substring(0, pathname.lastIndexOf('/') + 1);

console.log('BASE_PATH:', BASE_PATH);

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

const encodeUploadBox = document.getElementById('encode-upload-box');
const encodeFileInput = document.getElementById('encode-file-input');
const encodeSelectedFile = document.getElementById('encode-selected-file');
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

// Click to upload
encodeUploadBox.addEventListener('click', () => {
    encodeFileInput.click();
});

// File selection
encodeFileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        currentEncodeFile = e.target.files[0];
        encodeSelectedFile.textContent = `Selected: ${currentEncodeFile.name} (${formatFileSize(currentEncodeFile.size)})`;
        uploadAndEncodeFile();
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
    // Hide upload box, show progress
    encodeUploadBox.style.display = 'none';
    encodeSelectedFile.style.display = 'none';
    encodeProgressSection.style.display = 'block';
    encodeResultsSection.style.display = 'none';

    const formData = new FormData();
    formData.append('file', currentEncodeFile);

    try {
        // Upload file
        const url = `${BASE_PATH}api/encode`;
        console.log('Fetching URL:', url);
        const response = await fetch(url, {
            method: 'POST',
            body: formData
        });

        console.log('Response status:', response.status);
        if (!response.ok) {
            const errorText = await response.text();
            console.error('Error response:', errorText);
            throw new Error(`HTTP error! status: ${response.status}, body: ${errorText.substring(0, 200)}`);
        }

        const { sessionId } = await response.json();

        // Poll for progress
        pollProgress(sessionId, 'encode');
    } catch (err) {
        console.error('Error uploading file:', err);
        alert('Error uploading file. Please try again.');
        resetEncodeTab();
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

    const img = document.createElement('img');
    img.className = 'png-preview';
    img.src = `${BASE_PATH}api/png/${fileId}/${index}`;

    const p = document.createElement('p');
    p.textContent = `Image ${index + 1}`;

    const btn = document.createElement('button');
    btn.className = 'png-download-btn';
    btn.textContent = 'Download';
    btn.onclick = () => {
        window.location.href = `${BASE_PATH}api/png/${fileId}/${index}`;
    };

    div.appendChild(img);
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
    encodeProgressSection.style.display = 'none';
    encodeResultsSection.style.display = 'none';
    encodeFileInput.value = '';
    currentEncodeFile = null;
    currentFileId = null;
    currentDownloadToken = null;
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

let currentDecodeFiles = null;
let currentDecodeToken = null;

// Click to upload
decodeUploadBox.addEventListener('click', () => {
    decodeFileInput.click();
});

// File selection
decodeFileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        currentDecodeFiles = e.target.files;
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
async function uploadAndDecodeFiles() {
    // Hide upload box, show progress
    decodeUploadBox.style.display = 'none';
    decodeSelectedFile.style.display = 'none';
    decodeProgressSection.style.display = 'block';
    decodeResultsSection.style.display = 'none';
    decodeErrorSection.style.display = 'none';

    const formData = new FormData();

    for (let i = 0; i < currentDecodeFiles.length; i++) {
        formData.append('files', currentDecodeFiles[i]);
    }

    try {
        // Upload files
        const response = await fetch(`${BASE_PATH}api/decode`, {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const { sessionId } = await response.json();

        // Poll for progress
        pollProgress(sessionId, 'decode');
    } catch (err) {
        console.error('Error uploading files:', err);
        alert('Error uploading files. Please try again.');
        resetDecodeTab();
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
    currentDecodeFiles = null;
    currentDecodeToken = null;
}

// ==================== UTILITIES ====================

function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
