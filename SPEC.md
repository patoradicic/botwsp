# Especificación: Bot de WhatsApp para Stickers desde X (Twitter)

## Objetivo
Bot de WhatsApp conectado a un número dedicado (chip prepago) que recibe links de X/Twitter que contienen GIFs o videos cortos, descarga el archivo multimedia, lo convierte a sticker animado válido para WhatsApp (`.webp`) y lo devuelve en el mismo chat.

## Flujo de usuario
1. El usuario envía un mensaje con un link de X/Twitter (ej: `https://x.com/usuario/status/123456789/photo/1` o `https://twitter.com/usuario/status/123456789?s=20`).
2. El bot reacciona al mensaje con `⏳` para indicar que está procesando.
3. El bot extrae la URL directa del `.mp4` del tuit.
4. Convierte el video a formato sticker animado de WhatsApp (512x512 px, `.webp`, < 500 KB) con metadatos EXIF.
5. Responde citando el mensaje original con el sticker y cambia la reacción a `✅`.
6. Si falla (link sin video/GIF, cuenta privada, error de red), reacciona con `❌` y responde con un mensaje breve en español explicando el motivo.

## Alcance y casos borde
- **URLs soportadas:** `x.com`, `twitter.com`, `mobile.twitter.com`, `fxtwitter.com`, `vxtwitter.com`, con o sin `/photo/1`, `/video/1` o query params.
- **Tipos de media:**
  - GIFs de X (que internamente son `.mp4`).
  - Videos cortos de X (si duran más de 8 segundos, recortar a los primeros 8 segundos para no superar el límite de peso de WhatsApp).
  - Si el tuit solo tiene una imagen estática (JPG/PNG), convertirla igual a sticker estático `.webp` (512x512 px).
- **Chats permitidos:**
  - Responder siempre en chats privados (DM).
  - En grupos, ignorar mensajes a menos que una variable de entorno `ALLOW_GROUPS=true` esté activa.
- **Comandos básicos:**
  - `/start` o `/ayuda`: responde brevemente indicando que solo hay que mandar un link de X/Twitter.
  - Ignorar mensajes que no contengan links ni comandos para no spamear.

## Arquitectura y Stack Técnico
- **Runtime:** Node.js 20+ (ESM).
- **Cliente de WhatsApp:** `@whiskeysockets/baileys` (conexión vía WebSocket, sin navegador headless).
  - Soportar vinculación por **código QR en consola** y, opcionalmente, por **Pairing Code** (código de 8 dígitos usando variable de entorno `PHONE_NUMBER`) para vincular sin escanear QR en servidores remotos.
  - Persistencia de sesión en carpeta local configurable (`AUTH_DIR=./auth_info`).
- **Extracción de media (sin API paga de X):**
  - Proveedor principal: API pública de FxTwitter (`https://api.fxtwitter.com/{user}/status/{tweetId}`).
  - Fallback automático: API pública de VxTwitter (`https://api.vxtwitter.com/{user}/status/{tweetId}`).
- **Conversión a Sticker:**
  - `ffmpeg` instalado a nivel sistema (invocado con `fluent-ffmpeg` o `child_process`).
  - `node-webpmux` para inyectar metadatos EXIF (Pack Name y Author).
- **Servidor HTTP liviano (Healthcheck):**
  - Endpoint `GET /health` que devuelva `200 OK` (necesario para despliegues en Render, Railway, Koyeb o Fly.io).
- **Contenedorización:**
  - `Dockerfile` basado en `node:20-slim` con `ffmpeg` instalado, listo para deploy 24/7.

## Reglas de conversión FFmpeg (Crítico para WhatsApp)
WhatsApp exige un lienzo de 512x512 px para stickers animados, pero el sticker debe **respetar exactamente la relación de aspecto original del GIF/video (sin recortar ni deformar)**.

- **Formato:** `libwebp`, loop infinito (`-loop 0`), sin audio (`-an`).
- **Proporción original + fondo transparente (obligatorio):**
  - Nunca usar `crop` ni deformar el video a cuadrado.
  - Escalar el lado más largo a `512` manteniendo la proporción exacta y rellenar el resto del lienzo `512x512` con **transparencia real** (usando canal alfa `rgba`/`yuva420p` para evitar bordes negros o verdes).
  - Filtro base obligatorio:
    `format=rgba,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000`
  - Para la codificación con `libwebp`, usar `-pix_fmt yuva420p` para preservar la transparencia.
- **Peso máximo:** Menor a **500 KB** (apuntar a <= 450 KB).
- **Estrategia de compresión adaptativa (siempre manteniendo proporción original):**
  1. Primer intento: `fps=15`, `quality=65`, máx 8s.
  2. Si el archivo supera 480 KB, reintentar bajando a `fps=12`, `quality=45`, máx 6s.
  3. Si aún supera 480 KB, último intento: `fps=10`, `quality=30`, escalando el lado más largo a `384` con padding transparente a `512x512`, máx 5s.
- **Limpieza:** Borrar siempre los archivos temporales (`.mp4` y `.webp`) del disco en un bloque `finally` después de enviar o fallar.

## Variables de entorno (`.env.example`)
```env
PORT=3000
AUTH_DIR=./auth_info
STICKER_PACK=X Stickers
STICKER_AUTHOR=MiBot
ALLOW_GROUPS=false
PHONE_NUMBER=
LOG_LEVEL=info
```

## Estructura de carpetas esperada
```text
/
├── src/
│   ├── index.js              # Entrypoint: inicia HTTP server y cliente WhatsApp
│   ├── config.js             # Carga y validación de variables de entorno
│   ├── whatsapp/
│   │   ├── client.js         # Conexión Baileys, reconexión automática, QR / Pairing Code
│   │   └── handler.js        # Procesamiento de mensajes, regex, reacciones y respuestas
│   ├── services/
│   │   ├── twitter.js        # Extracción de media con FxTwitter + fallback VxTwitter
│   │   └── sticker.js        # Descarga temporal, conversión FFmpeg adaptativa y EXIF
│   └── utils/
│       └── temp.js           # Creación y borrado seguro de archivos temporales
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── .gitignore
├── package.json
└── README.md
```