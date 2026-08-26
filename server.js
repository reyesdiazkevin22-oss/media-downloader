const express = require('express');
const { exec, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Modo público vs. local ──────────────────────────────────────────
// Si hay credenciales de Supabase configuradas (Railway/producción), esta API
// exige que quien llama sea un miembro logueado de GRIT. Si no las hay (tu PC,
// uso personal), la herramienta funciona exactamente igual que siempre: sin login.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const PUBLIC_MODE = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
const supabase = PUBLIC_MODE ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

// ── cookies.txt desde variable de entorno (Railway) ──────────────────
// En Railway no hay archivo local: pega el contenido completo de tu cookies.txt
// en la variable de entorno COOKIES_TXT y aquí se escribe a disco al arrancar.
// En tu PC no hace falta nada de esto: ya tienes cookies.txt como archivo normal.
const cookiesPath = path.join(__dirname, 'cookies.txt');
if (process.env.COOKIES_TXT && !fs.existsSync(cookiesPath)) {
    fs.writeFileSync(cookiesPath, process.env.COOKIES_TXT);
    console.log('cookies.txt generado a partir de la variable de entorno COOKIES_TXT.');
}

async function requireAuth(req, res, next) {
    if (!PUBLIC_MODE) return next(); // uso local/personal: sin gate

    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    if (!token) return res.status(401).json({ error: 'No autenticado.' });

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: 'Sesión inválida o caducada. Vuelve a iniciar sesión.' });

    req.user = data.user;
    next();
}

// ── CORS: en modo público, solo la web de Proyecto GRIT puede llamar a esta API ──
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:3000';
const ALLOWED_ORIGINS = ALLOWED_ORIGIN.split(',').map(o => o.trim());
const isLocalOrigin = (origin) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

app.use(cors({
    origin: PUBLIC_MODE
        ? (origin, callback) => {
            // Sin cabecera Origin (curl, apps nativas) o localhost (pruebas antes de desplegar):
            // el token de sesión sigue siendo el filtro real, esto solo evita bloquear pruebas locales.
            if (!origin || ALLOWED_ORIGINS.includes(origin) || isLocalOrigin(origin)) return callback(null, true);
            return callback(new Error('Origen no permitido por CORS'));
        }
        : true
}));

// ── Rate limiting: solo tiene sentido en modo público (varios miembros compartiendo el servidor) ──
const apiLimiter = PUBLIC_MODE
    ? rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 20,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Demasiadas peticiones. Espera unos minutos e inténtalo de nuevo.' }
    })
    : (req, res, next) => next();

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

app.use(express.static(path.join(__dirname, 'public')));
app.use('/downloads', express.static(path.join(__dirname, 'downloads')));

// ── ffmpeg: en Linux (Docker/Railway) se instala vía apt y está en el PATH.
//    En Windows local, FFMPEG_DIR puede apuntar a la carpeta con ffmpeg.exe (por defecto, la raíz del proyecto). ──
const FFMPEG_DIR = process.env.FFMPEG_DIR || (process.platform === 'win32' && fs.existsSync(path.join(__dirname, 'ffmpeg.exe')) ? __dirname : null);
const FFMPEG_BIN = FFMPEG_DIR ? path.join(FFMPEG_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg') : 'ffmpeg';

// Detect platform from URL
function detectPlatform(url) {
    if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
    if (/instagram\.com|instagr\.am/i.test(url)) return 'instagram';
    if (/tiktok\.com|vm\.tiktok\.com/i.test(url)) return 'tiktok';
    return 'other';
}

// Sanitize URL to prevent command injection while allowing URL parameters
function sanitizeUrl(url) {
    return url.trim().replace(/["`$]/g, '');
}

// YouTube cookies can rotate/expire, which yt-dlp reports as one of these errors.
// When that happens, retry once without cookies instead of failing outright.
const RETRYABLE_YT_COOKIE_ERROR = /page needs to be reloaded|Sign in to confirm you're not a bot/i;

function execYtDlpWithCookieFallback(buildArgs, platform, execOptions, callback) {
    const cookiesFile = path.join(__dirname, 'cookies.txt');
    const hasCookies = fs.existsSync(cookiesFile);

    function attempt(useCookies) {
        const args = buildArgs(useCookies ? cookiesFile : null);
        execFile('python', args, execOptions, (error, stdout, stderr) => {
            if (error && useCookies && platform === 'youtube' && RETRYABLE_YT_COOKIE_ERROR.test(stderr || '')) {
                console.warn('[YOUTUBE] Cookies invalidas o caducadas, reintentando sin cookies...');
                return attempt(false);
            }
            callback(error, stdout, stderr);
        });
    }

    attempt(hasCookies);
}

// API: Get Video/Post Info
app.get('/api/info', requireAuth, apiLimiter, (req, res) => {
    const videoUrl = sanitizeUrl(req.query.url || '');
    if (!videoUrl) return res.status(400).json({ error: 'Falta la URL' });

    const platform = detectPlatform(videoUrl);

    // Build yt-dlp command with platform-specific options
    const buildArgs = (cookiesFile) => {
        const args = ['-m', 'yt_dlp', '--dump-json'];
        if (cookiesFile) {
            args.push('--cookies', cookiesFile);
        }
        if (platform === 'instagram' || platform === 'tiktok') {
            args.push('--impersonate', 'chrome');
        }
        if (platform === 'tiktok') {
            args.push('--referer', 'https://www.tiktok.com/');
        }
        if (platform === 'youtube') {
            args.push('--js-runtimes', 'node');
            args.push('--extractor-args', 'youtube:player_client=web_embedded,android');
        }
        args.push(videoUrl);
        return args;
    };

    const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' });
    execYtDlpWithCookieFallback(buildArgs, platform, { timeout: 30000, maxBuffer: 10 * 1024 * 1024, env }, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error fetching info (${platform}):`, error, stderr);
            let msg;
            if (/No module named yt_dlp/i.test(stderr)) {
                msg = 'Falta yt-dlp en Python. Ejecuta: python -m pip install -U yt-dlp';
            } else if (platform === 'youtube' && /Sign in to confirm you're not a bot/i.test(stderr)) {
                msg = 'YouTube ha bloqueado o rotado las cookies. Abre una ventana de incógnito, inicia sesión, visita youtube.com/robots.txt en esa misma pestaña, exporta solo las cookies de youtube.com y cierra la ventana de incógnito. Reemplaza cookies.txt sin volver a abrir esa sesión.';
            } else if (platform === 'youtube') {
                msg = 'No se pudo obtener la información de YouTube. Comprueba el enlace y, si continúa fallando, inicia sesión en YouTube y reemplaza cookies.txt por cookies recién exportadas.';
            } else if (platform === 'instagram') {
                msg = 'No se pudo obtener la informacion de Instagram. Necesitas exportar tus cookies de Instagram con la extension "Get cookies.txt LOCALLY" en Chrome y guardar el archivo como cookies.txt en la carpeta del proyecto.';
            } else {
                msg = 'No se pudo obtener la informacion del video. Comprueba el enlace.';
            }
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
            console.error('JSON parse error in info route:', e, 'stdout sample:', stdout.substring(0, 200));
            res.status(500).json({ error: 'Error al procesar la respuesta.' });
        }
    });
});

// Handle uncaught errors to prevent server crash
process.on('uncaughtException', (err) => {
    console.error('ALERTA: Error no capturado:', err);
});

// API: Download Video/Audio
app.get('/api/download', requireAuth, apiLimiter, (req, res) => {
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

    const buildArgs = (cookiesFile) => {
        const args = ['-m', 'yt_dlp'];

        if (platform === 'instagram') {
            args.push('--http-chunk-size', '10M');
            if (FFMPEG_DIR) args.push('--ffmpeg-location', FFMPEG_DIR);
            if (type === 'audio') {
                args.push('-f', 'ba/best');
            }
        } else if (platform === 'tiktok') {
            args.push('--referer', 'https://www.tiktok.com/');
            if (type === 'audio') {
                args.push('-S', 'vcodec:h264', '-f', 'b');
            } else {
                args.push('-f', 'b');
            }
        } else {
            if (type === 'audio') {
                args.push('-f', 'ba/best', '--extract-audio', '--audio-format', 'mp3');
                if (FFMPEG_DIR) args.push('--ffmpeg-location', FFMPEG_DIR);
            } else {
                args.push('-f', 'best[ext=mp4]/best');
            }
        }

        if (cookiesFile) {
            args.push('--cookies', cookiesFile);
        }
        if (platform === 'instagram' || platform === 'tiktok') {
            args.push('--impersonate', 'chrome');
        }
        if (platform === 'youtube') {
            args.push('--js-runtimes', 'node');
            args.push('--extractor-args', 'youtube:player_client=web_embedded,android');
        }

        args.push('-o', `${outputPath}.%(ext)s`, videoUrl);
        return args;
    };

    console.log(`[${platform.toUpperCase()}] Iniciando descarga para: ${videoUrl}`);

    const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' });
    execYtDlpWithCookieFallback(buildArgs, platform, { timeout: 120000, maxBuffer: 50 * 1024 * 1024, env }, (error, stdout, stderr) => {
        if (error) {
            console.error('Error en yt-dlp:', stderr);
            return res.status(500).send('Error durante el proceso de descarga.');
        }

        try {
            const files = fs.readdirSync(downloadsDir);
            const downloadedFile = files.find(f => f.startsWith(outputBase));

            if (!downloadedFile) {
                return res.status(500).send('No se pudo encontrar el archivo descargado.');
            }

            const downloadedPath = path.join(downloadsDir, downloadedFile);

            // Step 2: For TikTok/Instagram audio, use ffmpeg to extract audio as MP3
            if (type === 'audio' && (platform === 'tiktok' || platform === 'instagram')) {
                const mp3Path = path.join(downloadsDir, `${outputBase}.mp3`);
                // -vn = no video, -y = overwrite, libmp3lame = MP3 encoder, -q:a 2 = high quality VBR
                const extractCmd = `"${FFMPEG_BIN}" -i "${downloadedPath}" -vn -acodec libmp3lame -q:a 2 -y "${mp3Path}"`;

                console.log(`[${platform.toUpperCase()}] Extrayendo audio MP3...`);

                exec(extractCmd, { timeout: 60000 }, (err2, stdout2, stderr2) => {
                    // Always delete the intermediate video file
                    fs.unlink(downloadedPath, () => {});

                    // ffmpeg writes info to stderr, so a non-zero exit may still have produced output.
                    // Check if the output file actually exists instead of trusting exit code.
                    if (!fs.existsSync(mp3Path)) {
                        console.error('Error extrayendo audio con ffmpeg:', stderr2);
                        return res.status(500).send('Error al extraer el audio del video.');
                    }

                    console.log(`Enviando audio MP3: ${outputBase}.mp3`);
                    res.download(mp3Path, `${platform}_audio.mp3`, (err3) => {
                        if (err3) console.error('Error enviando MP3:', err3);
                        setTimeout(() => fs.unlink(mp3Path, () => {}), 60000);

                    });
                });
            } else {
                // Video or YouTube audio: send the file directly
                console.log(`Enviando archivo: ${downloadedFile}`);
                const ext = path.extname(downloadedFile);
                const isAudio = type === 'audio';
                const downloadName = `${platform}_${isAudio ? 'audio' : 'video'}${ext}`;

                res.download(downloadedPath, downloadName, (err) => {
                    if (err) console.error('Error enviando archivo:', err);
                    setTimeout(() => fs.unlink(downloadedPath, () => {}), 60000);
                });
            }
        } catch (e) {
            console.error('Error al procesar el archivo descargado:', e);
            res.status(500).send('Error interno al gestionar la descarga.');
        }
    });
});

// API: Transcribe Video/Audio from URL — disponible en local; en Railway no está
// instalado Whisper (no se usa desde la web pública, ver Nota en README).
app.get('/api/transcribe', requireAuth, apiLimiter, (req, res) => {
    const videoUrl = sanitizeUrl(req.query.url || '');
    if (!videoUrl) return res.status(400).json({ error: 'Falta la URL' });

    const timestamp = Date.now();
    const outputBase = `transcribe_${timestamp}`;
    const downloadsDir = path.join(__dirname, 'downloads');
    const outputPath = path.join(downloadsDir, outputBase);

    if (!fs.existsSync(downloadsDir)) {
        fs.mkdirSync(downloadsDir, { recursive: true });
    }

    const tPlatform = detectPlatform(videoUrl);

    const buildArgs = (cookiesFile) => {
        const args = ['-m', 'yt_dlp', '-f', 'ba/b'];
        if (FFMPEG_DIR) args.push('--ffmpeg-location', FFMPEG_DIR);
        if (tPlatform === 'instagram' || tPlatform === 'tiktok') {
            args.push('--impersonate', 'chrome');
        }
        if (tPlatform === 'tiktok') {
            args.push('--referer', 'https://www.tiktok.com/');
        }
        if (cookiesFile) {
            args.push('--cookies', cookiesFile);
        }
        if (tPlatform === 'youtube') {
            args.push('--js-runtimes', 'node');
            args.push('--extractor-args', 'youtube:player_client=web_embedded,android');
        }
        args.push('-o', `${outputPath}.%(ext)s`, videoUrl);
        return args;
    };

    console.log(`[TRANSCRIBE] Iniciando descarga para transcripción: ${videoUrl}`);

    const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' });
    execYtDlpWithCookieFallback(buildArgs, tPlatform, { timeout: 120000, env }, (error, stdout, stderr) => {
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
app.post('/api/extract-audio', requireAuth, apiLimiter, upload.single('video'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se subió ningún archivo.' });

    const inputPath = req.file.path;
    const originalName = path.parse(req.file.originalname).name;
    const timestamp = Date.now();
    const downloadsDir = path.join(__dirname, 'downloads');
    const outputPath = path.join(downloadsDir, `extracted_${timestamp}.mp3`);

    if (!fs.existsSync(downloadsDir)) {
        fs.mkdirSync(downloadsDir, { recursive: true });
    }

    const cmd = `"${FFMPEG_BIN}" -i "${inputPath}" -vn -acodec libmp3lame -ab 192k -ar 44100 -y "${outputPath}"`;

    console.log(`[EXTRACT] Extrayendo audio de: ${req.file.originalname}`);

    const env = { ...process.env };
    if (FFMPEG_DIR) {
        const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
        env[pathKey] = `${FFMPEG_DIR}${path.delimiter}${env[pathKey]}`;
    }

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
app.post('/api/transcribe-file', requireAuth, apiLimiter, upload.single('video'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se subió ningún archivo.' });

    const inputPath = req.file.path;

    console.log(`[TRANSCRIBE-FILE] Transcribiendo archivo: ${req.file.originalname}`);

    const env = { ...process.env };
    if (FFMPEG_DIR) {
        const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
        env[pathKey] = `${FFMPEG_DIR}${path.delimiter}${env[pathKey]}`;
    }

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
        console.error('Error no manejado:', err);
        return res.status(400).json({ error: err.message });
    }
    next();
});

app.listen(PORT, () => {
    console.log(`Servidor iniciado en http://localhost:${PORT}`);
    console.log(`Plataformas soportadas: YouTube, Instagram, TikTok`);
    console.log(`Modo: ${PUBLIC_MODE ? `PÚBLICO (login requerido, origen permitido: ${ALLOWED_ORIGIN})` : 'LOCAL (sin restricciones)'}`);
});
