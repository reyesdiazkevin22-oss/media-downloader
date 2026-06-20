const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const multer = require('multer');

// Configure multer for file uploads
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
    dest: uploadsDir,
    limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max
    fileFilter: (req, file, cb) => {
        const allowedTypes = /video|audio/;
        if (allowedTypes.test(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Solo se permiten archivos de video o audio.'));
        }
    }
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/downloads', express.static(path.join(__dirname, 'downloads')));

// Detect platform from URL
function detectPlatform(url) {
    if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
    if (/instagram\.com|instagr\.am/i.test(url)) return 'instagram';
    if (/tiktok\.com|vm\.tiktok\.com/i.test(url)) return 'tiktok';
    return 'other';
}

// Sanitize URL to prevent command injection while allowing URL parameters
function sanitizeUrl(url) {
    // Permitimos & = ? pero quitamos ; | ` $ y otros de control
    return url.replace(/[;|`$(){}<>]/g, '');
}

// API: Get Video/Post Info
app.get('/api/info', (req, res) => {
    const videoUrl = sanitizeUrl(req.query.url || '');
    if (!videoUrl) return res.status(400).json({ error: 'Falta la URL' });

    const platform = detectPlatform(videoUrl);

    // yt-dlp supports both YouTube and Instagram natively
    const cmd = `python -m yt_dlp --dump-json "${videoUrl}"`;
    
    exec(cmd, { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error fetching info (${platform}):`, stderr);
            const msg = platform === 'instagram'
                ? 'No se pudo obtener la información de Instagram. Asegúrate de que el enlace sea público.'
                : 'No se pudo obtener la información del video. Comprueba el enlace.';
            return res.status(500).json({ error: msg });
        }

        try {
            const data = JSON.parse(stdout);
            res.json({
                title: data.title || data.description?.substring(0, 80) || 'Contenido de Instagram',
                thumbnail: data.thumbnail,
                duration: data.duration,
                uploader: data.uploader || data.channel,
                view_count: data.view_count,
                platform: platform
            });
        } catch (e) {
            res.status(500).json({ error: 'Error al procesar la respuesta.' });
        }
    });
});

// Handle uncaught errors to prevent server crash
process.on('uncaughtException', (err) => {
    console.error('ALERTA: Error no capturado:', err);
});

// API: Download Video/Audio
app.get('/api/download', (req, res) => {
    const videoUrl = sanitizeUrl(req.query.url || '');
    const type = req.query.type;

    if (!videoUrl) return res.status(400).send('Falta la URL');

    const platform = detectPlatform(videoUrl);
    const timestamp = Date.now();
    const outputBase = `download_${timestamp}`;
    const downloadsDir = path.join(__dirname, 'downloads');
    const outputPath = path.join(downloadsDir, outputBase);

    // Ensure downloads directory exists
    if (!fs.existsSync(downloadsDir)) {
        fs.mkdirSync(downloadsDir, { recursive: true });
    }

    // Add current directory to PATH so tools can find ffmpeg.exe
    const env = { ...process.env };
    const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
    env[pathKey] = `${__dirname};${env[pathKey]}`;

    let formatCmd = '';
    let extraArgs = '';

    if (type === 'audio') {
        formatCmd = `-f "ba/best"`;
        extraArgs = `--extract-audio --audio-format mp3`;
    } else {
        // Instagram and TikTok: just get best quality available
        if (platform === 'instagram' || platform === 'tiktok') {
            formatCmd = `-f "best"`;
        } else {
            formatCmd = `-f "best[ext=mp4]/best"`;
        }
    }

    const cmd = `python -m yt_dlp ${formatCmd} ${extraArgs} -o "${outputPath}.%(ext)s" "${videoUrl}"`;

    console.log(`[${platform.toUpperCase()}] Iniciando descarga: ${cmd}`);

    exec(cmd, { timeout: 120000, maxBuffer: 50 * 1024 * 1024, env }, (error, stdout, stderr) => {
        if (error) {
            console.error('Error en yt-dlp:', stderr);
            return res.status(500).send('Error durante el proceso de descarga.');
        }

        try {
            // Find the file with the matching base name
            const files = fs.readdirSync(downloadsDir);
            const actualFile = files.find(f => f.startsWith(outputBase));
            
            if (actualFile) {
                const finalPath = path.join(downloadsDir, actualFile);
                console.log(`Enviando archivo: ${actualFile}`);

                // Forzar un nombre fácil de reconocer en el navegador del usuario en base a plataforma y tipo
                const ext = path.extname(actualFile);
                const isAudio = type === 'audio';
                const downloadName = `${platform}_${isAudio ? 'audio' : 'video'}${ext}`;

                res.download(finalPath, downloadName, (err) => {
                    if (err) console.error('Error enviando archivo al cliente:', err);
                    
                    // Eliminar el archivo del servidor local después de un tiempo para no llenarlo
                    setTimeout(() => {
                        fs.unlink(finalPath, () => {});
                    }, 60000); 
                });
            } else {
                res.status(500).send('No se pudo encontrar el archivo descargado.');
            }
        } catch (e) {
            console.error('Error al procesar el archivo descargado:', e);
            res.status(500).send('Error interno al gestionar la descarga.');
        }
    });
});
// API: Transcribe Video/Audio
app.get('/api/transcribe', (req, res) => {
    const videoUrl = sanitizeUrl(req.query.url || '');
    if (!videoUrl) return res.status(400).json({ error: 'Falta la URL' });

    const timestamp = Date.now();
    const outputBase = `transcribe_${timestamp}`;
    const downloadsDir = path.join(__dirname, 'downloads');
    const outputPath = path.join(downloadsDir, outputBase);

    if (!fs.existsSync(downloadsDir)) {
        fs.mkdirSync(downloadsDir, { recursive: true });
    }

    // Download audio only for transcription
    // Add current directory to PATH so tools can find ffmpeg.exe
    const env = { ...process.env };
    const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
    env[pathKey] = `${__dirname};${env[pathKey]}`;

    const downloadCmd = `python -m yt_dlp -f "ba/b" -o "${outputPath}.%(ext)s" "${videoUrl}"`;

    console.log(`[TRANSCRIBE] Iniciando descarga para transcripción: ${videoUrl}`);

    exec(downloadCmd, { timeout: 120000, env }, (error, stdout, stderr) => {
        if (error) {
            console.error('Error descargando para transcripción:', stderr);
            return res.status(500).json({ error: 'Error al descargar el audio para transcribir.' });
        }

        try {
            const files = fs.readdirSync(downloadsDir);
            const actualFile = files.find(f => f.startsWith(outputBase));
            
            if (actualFile) {
                const finalPath = path.join(downloadsDir, actualFile);
                console.log(`[TRANSCRIBE] Iniciando Whisper para: ${actualFile}`);

                const transcribeCmd = `python transcribe.py "${finalPath}"`;

                exec(transcribeCmd, { timeout: 300000, env }, (tError, tStdout, tStderr) => {
                    // Cleanup file immediately after transcription starts or fails
                    setTimeout(() => {
                        fs.unlink(finalPath, () => {});
                    }, 5000);

                    if (tError) {
                        console.error('Error en Whisper:', tStderr);
                        return res.status(500).json({ error: 'Error durante la transcripción.' });
                    }

                    try {
                        const result = JSON.parse(tStdout);
                        if (result.error) throw new Error(result.error);
                        res.json({ transcription: result.text });
                    } catch (e) {
                        res.status(500).json({ error: 'Error al procesar la transcripción.' });
                    }
                });
            } else {
                res.status(500).json({ error: 'No se pudo encontrar el archivo descargado.' });
            }
        } catch (e) {
            res.status(500).json({ error: 'Error interno en el servidor.' });
        }
    });
});

// API: Extract Audio from uploaded file
app.post('/api/extract-audio', upload.single('video'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se subió ningún archivo.' });

    const inputPath = req.file.path;
    const originalName = path.parse(req.file.originalname).name;
    const timestamp = Date.now();
    const downloadsDir = path.join(__dirname, 'downloads');
    const outputPath = path.join(downloadsDir, `extracted_${timestamp}.mp3`);

    if (!fs.existsSync(downloadsDir)) {
        fs.mkdirSync(downloadsDir, { recursive: true });
    }

    // Local ffmpeg path
    const ffmpegPath = path.join(__dirname, 'ffmpeg.exe');
    const ffmpeg = fs.existsSync(ffmpegPath) ? `"${ffmpegPath}"` : 'ffmpeg';

    const cmd = `${ffmpeg} -i "${inputPath}" -vn -acodec libmp3lame -ab 192k -ar 44100 -y "${outputPath}"`;

    console.log(`[EXTRACT] Extrayendo audio de: ${req.file.originalname}`);

    const env = { ...process.env };
    const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
    env[pathKey] = `${__dirname};${env[pathKey]}`;

    exec(cmd, { timeout: 300000, env }, (error, stdout, stderr) => {
        // Cleanup uploaded file
        fs.unlink(inputPath, () => {});

        if (error) {
            console.error('Error extrayendo audio:', stderr);
            return res.status(500).json({ error: 'Error al extraer el audio del video.' });
        }

        const downloadName = `${originalName}_audio.mp3`;

        res.download(outputPath, downloadName, (err) => {
            if (err) console.error('Error enviando archivo:', err);
            setTimeout(() => {
                fs.unlink(outputPath, () => {});
            }, 60000);
        });
    });
});

// API: Transcribe uploaded file
app.post('/api/transcribe-file', upload.single('video'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se subió ningún archivo.' });

    const inputPath = req.file.path;

    console.log(`[TRANSCRIBE-FILE] Transcribiendo archivo: ${req.file.originalname}`);

    const env = { ...process.env };
    const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
    env[pathKey] = `${__dirname};${env[pathKey]}`;

    const transcribeCmd = `python transcribe.py "${inputPath}"`;

    exec(transcribeCmd, { timeout: 300000, env }, (tError, tStdout, tStderr) => {
        // Cleanup uploaded file
        setTimeout(() => {
            fs.unlink(inputPath, () => {});
        }, 5000);

        if (tError) {
            console.error('Error en Whisper:', tStderr);
            return res.status(500).json({ error: 'Error durante la transcripción.' });
        }

        try {
            const result = JSON.parse(tStdout);
            if (result.error) throw new Error(result.error);
            res.json({ transcription: result.text });
        } catch (e) {
            res.status(500).json({ error: 'Error al procesar la transcripción.' });
        }
    });
});

// Multer error handling
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'El archivo es demasiado grande. Máximo 500MB.' });
        }
        return res.status(400).json({ error: err.message });
    }
    if (err) {
        return res.status(400).json({ error: err.message });
    }
    next();
});

app.listen(PORT, () => {
    console.log(`Servidor iniciado en http://localhost:${PORT}`);
    console.log(`Plataformas soportadas: YouTube, Instagram, TikTok`);
    console.log(`Extracción de audio local: Activada`);
});
