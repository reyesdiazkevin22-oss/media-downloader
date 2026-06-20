const fetchBtn = document.getElementById('fetch-btn');
const urlInput = document.getElementById('url-input');
const loader = document.getElementById('loader');
const preview = document.getElementById('video-preview');
const thumbnail = document.getElementById('thumbnail');
const titleEl = document.getElementById('title');
const uploaderEl = document.getElementById('uploader');
const durationEl = document.getElementById('duration');
const statusMsg = document.getElementById('status-msg');
const inputWrapper = document.getElementById('input-wrapper');
const platformIndicator = document.getElementById('platform-indicator');
const indicatorIcon = document.getElementById('indicator-icon');
const platformBadge = document.getElementById('platform-badge');
const downloadActions = document.getElementById('download-actions');

const dlVideoBtn = document.getElementById('dl-video');
const dlAudioBtn = document.getElementById('dl-audio');

let currentVideoUrl = '';
let currentPlatform = '';

// ==================== PLATFORM DETECTION ====================
function detectPlatform(url) {
    if (!url) return '';
    if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
    if (/instagram\.com|instagr\.am/i.test(url)) return 'instagram';
    if (/tiktok\.com|vm\.tiktok\.com/i.test(url)) return 'tiktok';
    return 'unknown';
}

function updateInputIndicator(platform) {
    // Reset classes
    inputWrapper.classList.remove('youtube-detected', 'instagram-detected', 'tiktok-detected');
    platformIndicator.classList.remove('youtube', 'instagram', 'tiktok');

    if (platform === 'youtube') {
        inputWrapper.classList.add('youtube-detected');
        platformIndicator.classList.add('youtube');
        indicatorIcon.textContent = '▶️';
        indicatorIcon.style.animation = 'pulse 1s ease-out';
    } else if (platform === 'instagram') {
        inputWrapper.classList.add('instagram-detected');
        platformIndicator.classList.add('instagram');
        indicatorIcon.textContent = '📸';
        indicatorIcon.style.animation = 'pulse 1s ease-out';
    } else if (platform === 'tiktok') {
        inputWrapper.classList.add('tiktok-detected');
        platformIndicator.classList.add('tiktok');
        indicatorIcon.textContent = '🎵';
        indicatorIcon.style.animation = 'pulse 1s ease-out';
    } else {
        indicatorIcon.textContent = '🔗';
        indicatorIcon.style.animation = 'none';
    }
}

// Live detection as user types/pastes
urlInput.addEventListener('input', () => {
    const platform = detectPlatform(urlInput.value.trim());
    updateInputIndicator(platform);
});

// ==================== PLATFORM PILLS ====================
document.querySelectorAll('.pill').forEach(pill => {
    pill.addEventListener('click', () => {
        document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');

        const platform = pill.dataset.platform;
        if (platform === 'youtube') {
            urlInput.placeholder = 'Pega el enlace de YouTube aquí...';
        } else if (platform === 'instagram') {
            urlInput.placeholder = 'Pega el enlace de Instagram aquí (Reel, Post, Historia)...';
        } else if (platform === 'tiktok') {
            urlInput.placeholder = 'Pega el enlace de TikTok aquí...';
        } else {
            urlInput.placeholder = 'Pega el enlace de YouTube, Instagram o TikTok aquí...';
        }
    });
});

// ==================== FETCH INFO ====================
fetchBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (!url) return showStatus('Por favor pega un enlace válido de YouTube, Instagram o TikTok.', true);

    const platform = detectPlatform(url);
    if (platform === 'unknown') {
        return showStatus('Enlace no reconocido. Usa enlaces de YouTube, Instagram o TikTok.', true);
    }

    currentPlatform = platform;
    showLoader(true);
    preview.style.display = 'none';
    statusMsg.style.display = 'none';

    try {
        const response = await fetch(`/api/info?url=${encodeURIComponent(url)}`);
        const data = await response.json();

        if (data.error) throw new Error(data.error);

        currentVideoUrl = url;

        // Set thumbnail
        thumbnail.src = data.thumbnail || '';
        titleEl.textContent = data.title || 'Sin título';
        
        // Set uploader
        if (data.uploader) {
            uploaderEl.textContent = `@${data.uploader}`;
            uploaderEl.style.display = 'block';
        } else {
            uploaderEl.style.display = 'none';
        }

        // Set duration
        if (data.duration) {
            durationEl.textContent = `Duración: ${formatDuration(data.duration)}`;
            durationEl.style.display = 'block';
        } else {
            durationEl.style.display = 'none';
        }

        // Platform badge
        platformBadge.className = 'platform-badge';
        if (platform === 'youtube') {
            platformBadge.textContent = 'YouTube';
            platformBadge.classList.add('youtube-badge');
        } else if (platform === 'instagram') {
            platformBadge.textContent = 'Instagram';
            platformBadge.classList.add('instagram-badge');
        } else if (platform === 'tiktok') {
            platformBadge.textContent = 'TikTok';
            platformBadge.classList.add('tiktok-badge');
        }

        // Thumbnail aspect ratio
        const thumbContainer = document.querySelector('.thumbnail-container');
        thumbContainer.classList.remove('instagram-thumb');
        if (platform === 'instagram') {
            thumbContainer.classList.add('instagram-thumb');
        }

        // Update download buttons based on platform
        updateDownloadButtons(platform);

        showLoader(false);
        preview.style.display = 'flex';
    } catch (err) {
        showLoader(false);
        showStatus('Error al analizar: ' + err.message, true);
    }
});

// ==================== DOWNLOAD & TRANSCRIBE ====================
function updateDownloadButtons(platform) {
    let extraBtns = `
        <button class="dl-btn" id="dl-transcribe" onclick="startTranscription()">
            <span class="icon">📝</span> Transcribir
        </button>
    `;

    if (platform === 'instagram') {
        downloadActions.innerHTML = `
            <button class="dl-btn instagram-primary" id="dl-video" onclick="startDownload('video')">
                <span class="icon">⬇️</span> Video (.mp4)
            </button>
            <button class="dl-btn" id="dl-audio" onclick="startDownload('audio')" style="border-color: rgba(220, 39, 67, 0.3);">
                <span class="icon">🎵</span> Audio (.mp3)
            </button>
            ${extraBtns}
        `;
    } else if (platform === 'tiktok') {
        downloadActions.innerHTML = `
            <button class="dl-btn tiktok-primary" id="dl-video" onclick="startDownload('video')">
                <span class="icon">⬇️</span> Video (.mp4)
            </button>
            <button class="dl-btn" id="dl-audio" onclick="startDownload('audio')" style="border-color: rgba(0, 240, 255, 0.2);">
                <span class="icon">🎵</span> Audio (.mp3)
            </button>
            ${extraBtns}
        `;
    } else {
        downloadActions.innerHTML = `
            <button class="dl-btn primary" id="dl-video" onclick="startDownload('video')">
                <span class="icon">⬇️</span> Video (.mp4)
            </button>
            <button class="dl-btn" id="dl-audio" onclick="startDownload('audio')">
                <span class="icon">🎵</span> Audio (.mp3)
            </button>
            ${extraBtns}
        `;
    }
}

function startDownload(type) {
    if (!currentVideoUrl) return;
    
    showStatus('Iniciando descarga... Por favor espere. ⏳', false);
    
    const downloadUrl = `/api/download?url=${encodeURIComponent(currentVideoUrl)}&type=${type}`;
    window.location.href = downloadUrl;
}

async function startTranscription() {
    if (!currentVideoUrl) return;

    const transcribeBtn = document.getElementById('dl-transcribe');
    const container = document.getElementById('transcription-container');
    const textEl = document.getElementById('transcription-text');
    
    showStatus('Transcribiendo... Esto puede tardar unos minutos. 🎙️', false);
    transcribeBtn.disabled = true;
    transcribeBtn.textContent = '...Transcribiendo';
    container.style.display = 'none';

    try {
        const response = await fetch(`/api/transcribe?url=${encodeURIComponent(currentVideoUrl)}`);
        const data = await response.json();

        if (data.error) throw new Error(data.error);

        textEl.textContent = data.transcription;
        container.style.display = 'block';
        showStatus('Transcripción completada con éxito. ✅', false);
        
        // Scroll to transcription
        container.scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
        showStatus('Error al transcribir: ' + err.message, true);
    } finally {
        transcribeBtn.disabled = false;
        transcribeBtn.innerHTML = '<span class="icon">📝</span> Transcribir';
    }
}

// Make functions globally accessible
window.startDownload = startDownload;
window.startTranscription = startTranscription;

// Copy button logic
document.getElementById('copy-transcription').addEventListener('click', () => {
    const text = document.getElementById('transcription-text').textContent;
    navigator.clipboard.writeText(text).then(() => {
        const copyBtn = document.getElementById('copy-transcription');
        const originalText = copyBtn.textContent;
        copyBtn.textContent = '¡Copiado!';
        setTimeout(() => copyBtn.textContent = originalText, 2000);
    });
});

// ==================== HELPERS ====================
function showLoader(show) {
    loader.style.display = show ? 'block' : 'none';
    fetchBtn.disabled = show;
    fetchBtn.textContent = show ? '...' : 'Analizar';
}

function showStatus(msg, isError) {
    statusMsg.textContent = msg;
    statusMsg.style.color = isError ? '#ef4444' : '#94a3b8';
    statusMsg.style.display = 'block';
}

function formatDuration(seconds) {
    if (!seconds) return '0:00';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    let ret = '';
    if (hrs > 0) ret += `${hrs}:${mins < 10 ? '0' : ''}`;
    ret += `${mins}:${secs < 10 ? '0' : ''}${secs}`;
    return ret;
}

// ==================== ENTER KEY SUPPORT ====================
urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        fetchBtn.click();
    }
});

// ==================== MODE TABS ====================
document.querySelectorAll('.mode-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.mode-content').forEach(c => c.classList.remove('active'));
        
        tab.classList.add('active');
        const mode = tab.dataset.mode;
        document.getElementById(`${mode}-mode`).classList.add('active');
    });
});

// ==================== FILE UPLOAD (DRAG & DROP) ====================
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const filePreview = document.getElementById('file-preview');
const fileNameEl = document.getElementById('file-name');
const fileSizeEl = document.getElementById('file-size');
const fileRemoveBtn = document.getElementById('file-remove');
const extractAudioBtn = document.getElementById('extract-audio-btn');
const transcribeFileBtn = document.getElementById('transcribe-file-btn');
const uploadStatusMsg = document.getElementById('upload-status-msg');

let selectedFile = null;

// Click to select
dropZone.addEventListener('click', () => fileInput.click());

// Drag events
dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const files = e.dataTransfer.files;
    if (files.length > 0) handleFileSelected(files[0]);
});

// File input change
fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) handleFileSelected(fileInput.files[0]);
});

function handleFileSelected(file) {
    selectedFile = file;
    fileNameEl.textContent = file.name;
    fileSizeEl.textContent = formatFileSize(file.size);
    
    dropZone.style.display = 'none';
    filePreview.style.display = 'block';
    
    // Reset states
    document.getElementById('upload-progress').style.display = 'none';
    document.getElementById('file-transcription-container').style.display = 'none';
    uploadStatusMsg.style.display = 'none';
}

// Remove file
fileRemoveBtn.addEventListener('click', () => {
    selectedFile = null;
    fileInput.value = '';
    filePreview.style.display = 'none';
    dropZone.style.display = 'block';
    document.getElementById('file-transcription-container').style.display = 'none';
    uploadStatusMsg.style.display = 'none';
});

// Extract audio
extractAudioBtn.addEventListener('click', async () => {
    if (!selectedFile) return;

    const formData = new FormData();
    formData.append('video', selectedFile);

    showUploadStatus('Extrayendo audio... Esto puede tardar unos segundos. 🎵', false);
    showProgress(true);
    extractAudioBtn.disabled = true;
    transcribeFileBtn.disabled = true;

    try {
        const response = await fetch('/api/extract-audio', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Error al extraer el audio.');
        }

        // Trigger download
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        
        // Get filename from Content-Disposition header
        const disposition = response.headers.get('Content-Disposition');
        let filename = 'audio.mp3';
        if (disposition) {
            const match = disposition.match(/filename="?(.+?)"?$/);
            if (match) filename = match[1];
        }
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showUploadStatus('Audio extraído con éxito. ✅', false);
    } catch (err) {
        showUploadStatus('Error: ' + err.message, true);
    } finally {
        showProgress(false);
        extractAudioBtn.disabled = false;
        transcribeFileBtn.disabled = false;
    }
});

// Transcribe file
transcribeFileBtn.addEventListener('click', async () => {
    if (!selectedFile) return;

    const formData = new FormData();
    formData.append('video', selectedFile);

    const container = document.getElementById('file-transcription-container');
    const textEl = document.getElementById('file-transcription-text');

    showUploadStatus('Transcribiendo... Esto puede tardar unos minutos. 🎙️', false);
    showProgress(true);
    extractAudioBtn.disabled = true;
    transcribeFileBtn.disabled = true;
    container.style.display = 'none';

    try {
        const response = await fetch('/api/transcribe-file', {
            method: 'POST',
            body: formData
        });

        const data = await response.json();
        if (data.error) throw new Error(data.error);

        textEl.textContent = data.transcription;
        container.style.display = 'block';
        showUploadStatus('Transcripción completada con éxito. ✅', false);
        container.scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
        showUploadStatus('Error: ' + err.message, true);
    } finally {
        showProgress(false);
        extractAudioBtn.disabled = false;
        transcribeFileBtn.disabled = false;
    }
});

// Copy button for file transcription
document.getElementById('copy-file-transcription').addEventListener('click', () => {
    const text = document.getElementById('file-transcription-text').textContent;
    navigator.clipboard.writeText(text).then(() => {
        const copyBtn = document.getElementById('copy-file-transcription');
        const original = copyBtn.textContent;
        copyBtn.textContent = '¡Copiado!';
        setTimeout(() => copyBtn.textContent = original, 2000);
    });
});

// ==================== UPLOAD HELPERS ====================
function showUploadStatus(msg, isError) {
    uploadStatusMsg.textContent = msg;
    uploadStatusMsg.style.color = isError ? '#ef4444' : '#94a3b8';
    uploadStatusMsg.style.display = 'block';
}

function showProgress(show) {
    const progress = document.getElementById('upload-progress');
    const fill = document.getElementById('progress-fill');
    
    if (show) {
        progress.style.display = 'block';
        // Simulate progress
        fill.style.width = '0%';
        let width = 0;
        const interval = setInterval(() => {
            width += Math.random() * 8;
            if (width > 90) width = 90;
            fill.style.width = width + '%';
        }, 500);
        progress.dataset.interval = interval;
    } else {
        const fill = document.getElementById('progress-fill');
        fill.style.width = '100%';
        clearInterval(progress.dataset.interval);
        setTimeout(() => {
            progress.style.display = 'none';
            fill.style.width = '0%';
        }, 500);
    }
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
