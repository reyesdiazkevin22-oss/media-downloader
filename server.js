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
app.set('trust proxy', 1); // Railway pone la app detrás de un proxy; sin esto, express-rate-limit no identifica bien la IP real.

// ── Modo público vs. local ──────────────────────────────────────────
// Si hay credenciales de Supabase configuradas (Railway/producción), esta API
// exige que quien llama sea un miembro logueado de GRIT. Si no las hay (tu PC,
// uso personal), la herramienta funciona exactamente igual que siempre: sin login.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const PUBLIC_MODE = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
const supabase = PUBLIC_MODE ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

// Cliente con permisos elevados, solo para el trabajo en segundo plano del
// Daruma (leer/escribir sin ser un usuario concreto). Nunca se expone al cliente.
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin = (PUBLIC_MODE && SUPABASE_SERVICE_ROLE_KEY) ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) : null;

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

app.use(express.json()); // solo para /api/goal-reflection; las rutas de descarga usan query params.

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
const RETRYABLE_YT_COOKIE_ERROR = /page needs to be reloaded|Sign in to confirm you're not a bot|cookies are no longer valid/i;

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
            args.push('--extractor-args', 'youtube:player_client=android,tv_embedded,web_embedded');
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
                msg = 'YouTube ha bloqueado esta descarga por sospechar tráfico automatizado (pasa de forma intermitente al descargar desde un servidor). Prueba de nuevo en un momento o con otro vídeo; si sigue fallando siempre, puede que las cookies necesiten renovarse.';
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
            args.push('--extractor-args', 'youtube:player_client=android,tv_embedded,web_embedded');
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

// ── Gemini: motor de IA del Daruma GRIT (reflexión en vivo + estrategia a 24h) ──
// Gemini a veces responde 503 "high demand" de forma pasajera — reintentamos un
// par de veces con una pequeña espera en vez de fallarle al usuario a la primera.
async function callGemini(prompt, attempt = 1) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('Falta configurar GEMINI_API_KEY en el servidor.');

    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });

    if (!response.ok) {
        const errorText = await response.text();
        if (response.status === 503 && attempt < 3) {
            await new Promise(resolve => setTimeout(resolve, attempt * 1500));
            return callGemini(prompt, attempt + 1);
        }
        throw new Error(`Gemini respondió ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) throw new Error('Respuesta vacía de Gemini.');
    return text;
}

// API: reflexión en vivo del Daruma GRIT (paso 6→7 del wizard de propósitos)
app.post('/api/goal-reflection', requireAuth, apiLimiter, async (req, res) => {
    const { title, obstacle, userName } = req.body || {};
    if (!title || !obstacle) return res.status(400).json({ error: 'Falta el propósito o la complicación.' });

    const prompt = `Eres Alexevin, hablando en primera persona y en español con un miembro de tu comunidad GRIT llamado "${userName || 'un miembro'}", dirigiéndote a él/ella de tú (segunda persona).
Su propósito es: "${title}".
Su mayor complicación para lograrlo, en sus propias palabras, es: "${obstacle}".

Escribe UNA sola frase, cálida y directa, siguiendo exactamente esta estructura (puedes ajustar palabras pero no la estructura):
"Okey, entonces tu propósito es [propósito], imagino que es para [una inferencia breve y razonable de por qué le importa], pero tenemos una complicación y es que [complicación], lo cual te impide llegar al objetivo."

Importante sobre [complicación]: "${obstacle}" es lo que el usuario escribió tal cual, con sus propias palabras — puede venir en primera persona, suelto, o con una redacción que no fluye bien si se inserta directo. No lo copies ni lo pegues literal: redáctalo de nuevo como una frase natural en segunda persona, razonando cuál es la idea real detrás de lo que escribió y expresándola con conectores naturales (por ejemplo, si hay una idea de contraste como "ya mejoro pero nunca dura", usa algo como "aunque..., nunca..." en vez de encadenar comas). Mantén el significado exacto, pero la redacción final debe sonar como si Alexevin lo hubiera pensado y dicho así, no como un recorte del texto original.
Ejemplo: si "${obstacle}" fuera "ya vas mejorando, pero nunca por 3 meses", [complicación] debería quedar algo como "aunque vas mejorando, nunca lo has hecho por 3 meses" — no "ya vas mejorando, pero nunca por 3 meses" tal cual.
Revisa la concordancia de todos los verbos y pronombres de la frase final antes de responder.
Responde solo con esa frase, sin comillas ni texto antes o después.`;

    try {
        const reflection = await callGemini(prompt);
        res.json({ reflection });
    } catch (err) {
        console.error('Error generando reflexión:', err);
        res.status(500).json({ error: 'No se pudo generar la reflexión. Inténtalo de nuevo.' });
    }
});

// API: avisa a Alexevin DE INMEDIATO de que un propósito quedó esperando estrategia, en
// vez de esperar al barrido por hora — lo llama el wizard justo al cerrarse (finishWizard).
// El barrido por hora (sendPendingStrategyNotifications) sigue como respaldo, por si esta
// llamada no llega a completarse (el usuario cierra la pestaña antes de que responda, etc.).
app.post('/api/notify-pending-strategy', requireAuth, apiLimiter, async (req, res) => {
    if (!supabaseAdmin) return res.json({ ok: true }); // sin SUPABASE_SERVICE_ROLE_KEY, no hay nada que hacer
    const { goalId } = req.body || {};
    if (!goalId) return res.status(400).json({ error: 'Falta goalId.' });

    const { data: goal, error } = await supabaseAdmin
        .from('member_goals')
        .select('id, user_id, title, obstacle, reflection_text, first_eye_painted_at, strategy_ready_at, admin_notified_at')
        .eq('id', goalId)
        .eq('user_id', req.user.id) // solo puede disparar el aviso de su propio objetivo
        .single();
    if (error || !goal) return res.status(404).json({ error: 'Objetivo no encontrado.' });

    try {
        await notifyAdminAboutGoal(goal);
        res.json({ ok: true });
    } catch (err) {
        console.error('Error en aviso instantáneo:', err);
        res.status(500).json({ error: 'No se pudo avisar.' }); // el barrido por hora lo recoge igual
    }
});

// API: anuncio del lanzamiento del muñeco de los propósitos a TODOS los usuarios, salvo
// quien haya pedido explícitamente que no se le avise (purpose_doll_announce_opt_out) y
// quien ya haya sido avisado antes. A quien sí pidió que le avisáramos (consentimiento
// capturado antes de que la función existiera) se le manda un copy distinto reconociendo
// que lo pidió; al resto, un anuncio genérico. Protegido por admin (misma tabla que usa
// is_grit_admin() en Supabase) — lo llama Alexevin a mano, no es un job automático.
// Idempotente: marca a cada quien como avisado, así que correrlo de nuevo no reenvía nada.
app.post('/api/announce-daruma-launch', requireAuth, apiLimiter, async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'No configurado.' });
    const { data: adminRow } = await supabaseAdmin.from('app_admins').select('user_id').eq('user_id', req.user.id).maybeSingle();
    if (!adminRow) return res.status(403).json({ error: 'No autorizado.' });

    const testEmail = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : null;

    try {
        let sent = 0, failed = 0, page = 1;
        const perPage = 200;
        while (true) {
            const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
            if (error) throw error;
            const users = data?.users || [];
            if (!users.length) break;

            for (const user of users) {
                if (testEmail && user.email?.toLowerCase() !== testEmail) continue;

                const meta = user.user_metadata || {};
                if (!testEmail) {
                    if (meta.purpose_doll_announced_at) continue; // ya avisado antes
                    if (meta.purpose_doll_announce_opt_out === true) continue; // pidió que no se le avisara
                }

                try {
                    const userName = meta.full_name || user.email.split('@')[0];
                    const askedToBeNotified = meta.purpose_doll_email_consent === true;
                    const bodyText = askedToBeNotified
                        ? `Me pediste que te avisara cuando la nueva función de los propósitos estuviera lista. Pues ya está disponible, me gustaría que la probaras y me respondieras a este correo contándome qué te ha parecido.`
                        : `¿Cómo se supone que lo vas a lograr, si ni siquiera has probado el muñeco de los propósitos? Te doy una estrategia exacta de cómo conseguirlo, y sí, como todo en la web, es gratis.`;
                    await sendEmail(
                        user.email,
                        'Ya está listo: el muñeco de los propósitos',
                        emailShell({
                            preheader: askedToBeNotified ? 'Me pediste que te avisara en cuanto estuviera listo — ya lo está.' : '¿Cómo lo vas a lograr si ni siquiera lo has probado?',
                            bodyHtml: `
          <tr>
            <td style="padding:16px 40px 0; text-align:center;">
              <p style="margin:0; font-size:14px; line-height:1.65; color:#b0b0b5;">
                Hola <strong style="color:#ffffff;">${escapeHtml(userName)}</strong>! ${bodyText}
              </p>
            </td>
          </tr>
          ${emailCtaButton('Probar nueva función', GRIT_SITE_URL)}`
                        })
                    );

                    if (!testEmail) {
                        await supabaseAdmin.auth.admin.updateUserById(user.id, {
                            user_metadata: { ...meta, purpose_doll_announced_at: new Date().toISOString() }
                        });
                    }
                    sent++;
                } catch (err) {
                    failed++;
                    console.error('Error avisando a', user.email, ':', err.message);
                }

                if (testEmail) break;
            }

            if (testEmail && sent + failed > 0) break;
            if (users.length < perPage) break;
            page++;
        }
        res.json({ ok: true, sent, failed });
    } catch (err) {
        console.error('Error en el anuncio del lanzamiento:', err);
        res.status(500).json({ error: 'No se pudo completar el anuncio.' });
    }
});

// API: correo manual con el diseño de GRIT. Alexevin escribe el mensaje a mano desde
// analytics.html y el servidor lo envuelve en la plantilla de marca (Gmail no permite eso).
app.post('/api/admin-send-email', requireAuth, apiLimiter, async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'No configurado.' });
    const { data: adminRow } = await supabaseAdmin.from('app_admins').select('user_id').eq('user_id', req.user.id).maybeSingle();
    if (!adminRow) return res.status(403).json({ error: 'No autorizado.' });

    const { to, subject, message, ctaLabel, ctaUrl } = req.body || {};
    const cleanTo = typeof to === 'string' ? to.trim() : '';
    const cleanSubject = typeof subject === 'string' ? subject.trim() : '';
    const cleanMessage = typeof message === 'string' ? message.trim() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanTo)) return res.status(400).json({ error: 'Correo inválido.' });
    if (!cleanSubject || cleanSubject.length > 150) return res.status(400).json({ error: 'El asunto es obligatorio (máx. 150 caracteres).' });
    if (!cleanMessage || cleanMessage.length > 5000) return res.status(400).json({ error: 'El mensaje es obligatorio (máx. 5000 caracteres).' });
    const cleanCtaLabel = typeof ctaLabel === 'string' ? ctaLabel.trim().slice(0, 60) : '';
    const cleanCtaUrl = typeof ctaUrl === 'string' ? ctaUrl.trim() : '';
    if (cleanCtaLabel && !/^https:\/\/(www\.)?proyectogrit\.com(\/|$)/.test(cleanCtaUrl)) {
        return res.status(400).json({ error: 'El botón solo puede apuntar a proyectogrit.com.' });
    }

    const paragraphs = cleanMessage.split(/\n{2,}/).map(p =>
        `<p style="margin:0 0 14px; font-size:14px; line-height:1.65; color:#b0b0b5; text-align:left;">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`
    ).join('');

    try {
        await sendEmail(
            cleanTo,
            cleanSubject,
            emailShell({
                preheader: cleanMessage.slice(0, 90).replace(/\s+/g, ' '),
                bodyHtml: `
          <tr>
            <td style="padding:16px 40px 0;">${paragraphs}</td>
          </tr>
          ${cleanCtaLabel ? emailCtaButton(cleanCtaLabel, cleanCtaUrl) : ''}`
            })
        );
        res.json({ ok: true });
    } catch (err) {
        console.error('Error enviando correo manual:', err.message);
        res.status(502).json({ error: 'Resend rechazó el envío. Mira los logs de Railway.' });
    }
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
            args.push('--extractor-args', 'youtube:player_client=android,tv_embedded,web_embedded');
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

// ── Daruma GRIT: trabajos en segundo plano (recordatorios + entrega de estrategia a 24h) ──
function escapeHtml(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const GRIT_SITE_URL = 'https://www.proyectogrit.com/propositos.html';

// Mismo lenguaje visual que data/email-confirmacion.html (la plantilla de Supabase ya en
// uso): tarjeta oscura basada en <table> (compatibilidad con clientes de correo), UTF-8
// explícito. Se añade una franja granate arriba, propia del Daruma GRIT.
function emailShell({ preheader, bodyHtml }) {
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark">
<title>Proyecto GRIT</title>
</head>
<body style="margin:0; padding:0; background-color:#000000; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">

  <div style="display:none; max-height:0; overflow:hidden; opacity:0;">${escapeHtml(preheader)}</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#000000; padding:40px 16px;">
    <tr>
      <td align="center">

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px; background-color:#101010; border:1px solid rgba(255,255,255,0.06); border-radius:14px; overflow:hidden;">

          <tr><td style="height:3px; background-color:#c9363b; font-size:0; line-height:0;">&nbsp;</td></tr>

          <tr>
            <td style="padding:32px 40px 0; text-align:center;">
              <img src="https://proyectogrit.com/public/branding/logohorizontal.PNG" alt="Proyecto GRIT" style="max-width:240px; height:auto; display:inline-block;">
            </td>
          </tr>

          ${bodyHtml}

          <tr>
            <td style="padding:36px 40px 0;">
              <div style="border-top:1px solid rgba(255,255,255,0.06);"></div>
            </td>
          </tr>

          <tr>
            <td style="padding:20px 40px 40px; text-align:center;">
              <p style="margin:0; font-size:11.5px; line-height:1.6; color:#55555e;">
                Proyecto GRIT · Alexevin
              </p>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>

</body>
</html>`;
}

function emailCtaButton(label, url) {
    return `<tr>
    <td style="padding:28px 40px 0; text-align:center;">
      <a href="${url}" style="display:inline-block; padding:14px 42px; background-color:#ffffff; color:#000000; font-size:13.5px; font-weight:600; text-decoration:none; border-radius:6px;">${escapeHtml(label)}</a>
    </td>
  </tr>`;
}

async function sendEmail(to, subject, html) {
    if (!process.env.RESEND_API_KEY) {
        console.warn('RESEND_API_KEY no configurada, no se pudo enviar el correo:', subject);
        return;
    }
    const from = process.env.RESEND_FROM_EMAIL || 'GRIT <onboarding@resend.dev>';
    const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to, subject, html, reply_to: process.env.RESEND_REPLY_TO || 'alexevin@proyectogrit.com' })
    });
    if (!response.ok) {
        // Antes esto solo se logueaba — quien llamaba a sendEmail nunca se enteraba del
        // fallo y seguía adelante como si se hubiera entregado (marcando "enviado",
        // "avisado", etc. aunque Resend lo hubiera rechazado). Lanzar el error es lo que
        // permite a cada llamador decidir si reintentar, no marcar como hecho, etc.
        const errText = await response.text();
        console.error('Error enviando email con Resend:', response.status, errText);
        throw new Error(`Resend ${response.status}: ${errText}`);
    }
}

async function sendDueReminders() {
    const { data: dueGoals, error } = await supabaseAdmin
        .from('member_goals')
        .select('id, user_id, title, reminder_cadence_days, last_reminder_sent_at')
        .eq('status', 'active')
        .eq('reminder_enabled', true);
    if (error) return console.error('Error consultando recordatorios pendientes:', error.message);

    const now = Date.now();
    for (const goal of dueGoals || []) {
        try {
            const cadenceMs = goal.reminder_cadence_days * 24 * 60 * 60 * 1000;
            const last = goal.last_reminder_sent_at ? new Date(goal.last_reminder_sent_at).getTime() : 0;
            if (now - last < cadenceMs) continue;

            const { data: userData } = await supabaseAdmin.auth.admin.getUserById(goal.user_id);
            const email = userData?.user?.email;
            if (!email) continue;

            await sendEmail(
                email,
                '¿Cómo vas con tu propósito?',
                emailShell({
                    preheader: 'Un check-in rápido para seguir en movimiento.',
                    bodyHtml: `
          <tr>
            <td style="padding:16px 40px 0; text-align:center;">
              <p style="margin:0; font-size:14px; line-height:1.65; color:#b0b0b5;">
                ¿Cómo vas con <strong style="color:#ffffff;">"${escapeHtml(goal.title)}"</strong>? Cuéntame en un check-in cómo lo llevas — seguimos esto juntos.
              </p>
            </td>
          </tr>
          ${emailCtaButton('Hacer check-in', GRIT_SITE_URL)}`
                })
            );
            await supabaseAdmin.from('member_goals').update({ last_reminder_sent_at: new Date().toISOString() }).eq('id', goal.id);
        } catch (err) {
            console.error('Error enviando recordatorio para goal', goal.id, err.message);
        }
    }
}

// La estrategia ya no la genera la IA: Alexevin sube el PDF a mano a Supabase Storage y
// pega la URL en member_goals.strategy_pdf_url (ver supabase-setup.sql). Este job ya no
// dispara por tiempo ("24 horas") — dispara en cuanto el PDF está realmente adjunto, lo
// cual Alexevin hace a propósito antes de esas 24h para dar sensación de rapidez.
async function sendReadyStrategyEmails() {
    const { data: readyGoals, error } = await supabaseAdmin
        .from('member_goals')
        .select('id, user_id, title')
        .eq('status', 'active')
        .is('strategy_sent_at', null)
        .not('strategy_pdf_url', 'is', null)
        .order('strategy_ready_at', { ascending: true })
        .limit(1); // uno por minuto: así no salen varios correos a la vez (llegan mejor a la bandeja)
    if (error) return console.error('Error consultando estrategias listas:', error.message);

    for (const goal of readyGoals || []) {
        try {
            const { data: userData } = await supabaseAdmin.auth.admin.getUserById(goal.user_id);
            const email = userData?.user?.email;
            if (email) {
                const userName = userData.user.user_metadata?.full_name || email.split('@')[0];
                await sendEmail(
                    email,
                    `Tu estrategia para "${goal.title}" ya está lista`,
                    emailShell({
                        preheader: 'Ya puedes verla en tu panel GRIT y empezar.',
                        bodyHtml: `
          <tr>
            <td style="padding:16px 40px 0; text-align:center;">
              <p style="margin:0; font-size:14px; line-height:1.65; color:#b0b0b5;">
                Hola <strong style="color:#ffffff;">${escapeHtml(userName)}</strong>, te dije que te ayudaría y lo voy a hacer, recuerda que hiciste una promesa y te comprometiste a dar tu mejor esfuerzo. Confío en que será así, tu estrategia ya está subida en tu panel GRIT.
              </p>
            </td>
          </tr>
          ${emailCtaButton('Ver mi estrategia', GRIT_SITE_URL)}`
                    })
                );
            }

            await supabaseAdmin.from('member_goals').update({ strategy_sent_at: new Date().toISOString() }).eq('id', goal.id);
        } catch (err) {
            console.error('Error avisando la estrategia para el objetivo', goal.id, err);
        }
    }
}

const SUPABASE_PROJECT_REF = 'kjwhdrqiicaztaiaczvy';
function formatDateTimeEs(value) {
    return new Date(value).toLocaleString('es-ES', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Avisa a Alexevin (no al usuario) de UN propósito concreto que quedó esperando
// estrategia — con todo lo necesario para escribirla, y el UPDATE ya armado para cuando
// suba el PDF. La llama tanto el endpoint instantáneo (justo al cerrar el wizard) como el
// barrido por hora (respaldo, por si esa llamada instantánea no llegó a completarse).
async function notifyAdminAboutGoal(goal) {
    if (!process.env.ADMIN_NOTIFY_EMAIL) {
        console.warn('ADMIN_NOTIFY_EMAIL no configurada, no se pudo avisar del objetivo', goal.id);
        return;
    }
    if (goal.admin_notified_at) return; // ya se avisó de este

    const { data: userData } = await supabaseAdmin.auth.admin.getUserById(goal.user_id);
    const email = userData?.user?.email || '(sin correo)';
    const userName = userData?.user?.user_metadata?.full_name || email.split('@')[0];
    const storageUrl = `https://supabase.com/dashboard/project/${SUPABASE_PROJECT_REF}/storage/buckets/strategies`;
    const updateSql = `update public.member_goals set strategy_pdf_url = '...' where id = '${goal.id}';`;

    await sendEmail(
        process.env.ADMIN_NOTIFY_EMAIL,
        `Nueva estrategia por escribir: "${goal.title}" (${userName})`,
        emailShell({
            preheader: `${userName} está esperando su estrategia para "${goal.title}".`,
            bodyHtml: `
          <tr>
            <td style="padding:16px 40px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px; line-height:1.7; color:#b0b0b5;">
                <tr><td style="padding:4px 0;"><strong style="color:#ffffff;">Nombre:</strong> ${escapeHtml(userName)}</td></tr>
                <tr><td style="padding:4px 0;"><strong style="color:#ffffff;">Correo:</strong> ${escapeHtml(email)}</td></tr>
                <tr><td style="padding:4px 0;"><strong style="color:#ffffff;">Propósito:</strong> ${escapeHtml(goal.title)}</td></tr>
                <tr><td style="padding:4px 0;"><strong style="color:#ffffff;">Complicación:</strong> ${escapeHtml(goal.obstacle || '—')}</td></tr>
                <tr><td style="padding:4px 0;"><strong style="color:#ffffff;">Reflexión ya enviada:</strong> ${escapeHtml(goal.reflection_text || '—')}</td></tr>
                <tr><td style="padding:4px 0;"><strong style="color:#ffffff;">Se comprometió el:</strong> ${formatDateTimeEs(goal.first_eye_painted_at)}</td></tr>
                <tr><td style="padding:4px 0;"><strong style="color:#ffffff;">Debe estar lista antes del:</strong> ${formatDateTimeEs(goal.strategy_ready_at)}</td></tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 40px 0;">
              <div style="border-top:1px solid rgba(255,255,255,0.06); padding-top:16px;">
                <p style="margin:0 0 8px; font-size:12px; color:#777;">Cuando tengas el PDF subido, pega esto en el SQL Editor de Supabase (solo falta la URL):</p>
                <p style="margin:0; font-family:monospace; font-size:12px; color:#c9363b; background:#0a0a0a; border-radius:6px; padding:12px; word-break:break-all;">${escapeHtml(updateSql)}</p>
              </div>
            </td>
          </tr>
          ${emailCtaButton('Subir el PDF ahora', storageUrl)}`
        })
    );

    await supabaseAdmin.from('member_goals').update({ admin_notified_at: new Date().toISOString() }).eq('id', goal.id);
}

// Respaldo por hora — recoge cualquier propósito que haya quedado esperando estrategia
// sin que el aviso instantáneo (ver /api/notify-pending-strategy) haya llegado a avisar.
async function sendPendingStrategyNotifications() {
    if (!process.env.ADMIN_NOTIFY_EMAIL) {
        console.warn('ADMIN_NOTIFY_EMAIL no configurada, el barrido por hora no avisará a nadie.');
        return;
    }
    const { data: pendingGoals, error } = await supabaseAdmin
        .from('member_goals')
        .select('id, user_id, title, obstacle, reflection_text, first_eye_painted_at, strategy_ready_at, admin_notified_at')
        .eq('status', 'active')
        .not('strategy_ready_at', 'is', null)
        .is('admin_notified_at', null);
    if (error) return console.error('Error consultando propósitos pendientes de aviso:', error.message);

    for (const goal of pendingGoals || []) {
        try {
            await notifyAdminAboutGoal(goal);
        } catch (err) {
            console.error('Error avisando propósito pendiente', goal.id, err);
        }
    }
}

async function runBackgroundJobs() {
    if (!supabaseAdmin) return; // Sin SUPABASE_SERVICE_ROLE_KEY configurada, no hay nada que hacer aquí.
    // Recordatorios "¿Cómo vas con tu propósito?" desactivados a propósito; sendDueReminders() se conserva por si se reactivan.
    await sendPendingStrategyNotifications();
}

app.listen(PORT, () => {
    console.log(`Servidor iniciado en http://localhost:${PORT}`);
    console.log(`Plataformas soportadas: YouTube, Instagram, TikTok`);
    console.log(`Modo: ${PUBLIC_MODE ? `PÚBLICO (login requerido, origen permitido: ${ALLOWED_ORIGIN})` : 'LOCAL (sin restricciones)'}`);

    if (supabaseAdmin) {
        console.log('Daruma GRIT: trabajos en segundo plano activados (cada hora).');
        runBackgroundJobs().catch(err => console.error('Error en trabajos en segundo plano (arranque):', err));
        setInterval(() => runBackgroundJobs().catch(err => console.error('Error en trabajos en segundo plano:', err)), 60 * 60 * 1000);
        // La estrategia se envía casi al instante: se revisa cada minuto si Alexevin ya subió algún PDF.
        let strategyEmailsRunning = false;
        setInterval(async () => {
            if (strategyEmailsRunning) return;
            strategyEmailsRunning = true;
            try { await sendReadyStrategyEmails(); } catch (err) { console.error('Error enviando estrategias listas:', err); } finally { strategyEmailsRunning = false; }
        }, 60 * 1000);
    }
});
