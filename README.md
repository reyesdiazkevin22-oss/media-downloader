# 🎬 Media Downloader

Herramienta local para **descargar, extraer audio y transcribir** contenido multimedia de YouTube, Instagram y TikTok — además de archivos locales.

![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat&logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-000000?style=flat&logo=express&logoColor=white)
![Python](https://img.shields.io/badge/Python-3776AB?style=flat&logo=python&logoColor=white)
![Whisper](https://img.shields.io/badge/OpenAI_Whisper-412991?style=flat&logo=openai&logoColor=white)

## ✨ Funcionalidades

| Función | Descripción |
|---|---|
| 🔗 **Descargar desde URL** | Descarga video o audio de YouTube, Instagram y TikTok |
| 📁 **Subir archivo** | Sube un video local y extrae el audio en MP3 |
| 📝 **Transcripción IA** | Transcribe cualquier video a texto usando Whisper AI (local, gratis) |
| 🎵 **Extraer audio** | Convierte video a MP3 a 192kbps con ffmpeg |

## 🚀 Instalación

### Requisitos previos
- [Node.js](https://nodejs.org/) (v18+)
- [Python](https://www.python.org/) (v3.10+)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (`pip install yt-dlp`)
- [ffmpeg](https://ffmpeg.org/) (descargar y colocar `ffmpeg.exe` en la raíz del proyecto)

### Pasos

```bash
# 1. Clona el repositorio
git clone https://github.com/reyesdiazkevin22-oss/media-downloader.git
cd media-downloader

# 2. Instala dependencias de Node.js
npm install

# 3. Instala Whisper (opcional, para transcripción)
pip install openai-whisper

# 4. Descarga ffmpeg y coloca ffmpeg.exe en la raíz del proyecto

# 5. Inicia el servidor
npm start
```

Abre **http://localhost:3000** en tu navegador. 🎉

## 🛠️ Stack Tecnológico

- **Backend:** Node.js + Express
- **Motor de descarga:** yt-dlp (Python)
- **Extracción de audio:** ffmpeg
- **Transcripción:** OpenAI Whisper (modelo `base`, local)
- **Frontend:** HTML + CSS + JavaScript vanilla

## 📝 Notas

- La transcripción se ejecuta **100% local** en tu PC. No se envía nada a la nube.
- La primera vez que transcribas, Whisper descargará automáticamente el modelo (~150MB).
- Los archivos temporales se eliminan automáticamente del servidor tras 60 segundos.
- ffmpeg.exe no se incluye en el repositorio por su tamaño (~83MB). Descárgalo de [gyan.dev](https://www.gyan.dev/ffmpeg/builds/).

## 📄 Licencia

MIT
