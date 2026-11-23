# 🎞️ X Sticker Bot (WhatsApp)

Bot de WhatsApp que recibe links de **X / Twitter** con GIFs, videos o imágenes y responde con el **sticker** listo para usar.

- Mandás `https://x.com/usuario/status/123…` → el bot reacciona ⏳ → responde con el sticker y cambia a ✅.
- Si algo falla (tuit sin media, cuenta privada, error de red) reacciona ❌ y explica el motivo.
- GIFs y videos → sticker **animado** (512×512, < 500 KB, recortado a 8 s como máximo).
- Imágenes → sticker **estático**.
- Respeta la proporción original con fondo **transparente** (no recorta ni deforma).
- Sin API paga de X: usa [FxTwitter](https://github.com/FixTweet/FxTwitter) y, si falla, VxTwitter.

## Requisitos

- **Node.js 20 o superior** (recomendado 22/24: Node 20 dejó de tener soporte en abril 2026).
- **FFmpeg** instalado y disponible en el `PATH` (con soporte `libwebp`, viene en casi todas las builds).
  - Windows: `winget install Gyan.FFmpeg`
  - macOS: `brew install ffmpeg`
  - Debian/Ubuntu: `sudo apt install ffmpeg`
- Un **número de WhatsApp dedicado** para el bot (ej: chip prepago). No uses tu número personal.

Verificá con:

```bash
node -v
ffmpeg -version
```

## Correr en local

```bash
npm install
cp .env.example .env     # en Windows: copy .env.example .env
npm start
```

> **Windows / PowerShell:** si aparece *"la ejecución de scripts está deshabilitada"*, usá `npm.cmd` en lugar de `npm` (ej: `npm.cmd start`) o ejecutá una vez `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

Siempre corré los comandos **dentro de la carpeta del proyecto**.

### Probar la conversión sin WhatsApp

Podés probar la extracción y generación del sticker sin vincular ningún número:

```bash
npm run test:twitter -- https://x.com/usuario/status/123456789
```

El sticker queda en `output/sticker-<id>.webp` (se puede abrir con Chrome/Edge) y la consola muestra dimensiones, peso y metadatos.

## Vincular el número del bot

El bot funciona en **modo híbrido**:
- **Local (sin base de datos):** si `MONGODB_URI` está vacío, la sesión se guarda en `AUTH_DIR` (`./auth_info`).
- **Producción (MongoDB Atlas):** si `MONGODB_URI` está configurado, la sesión se guarda en la colección `baileys_auth` de MongoDB (sobrevive a reinicios y deploys en discos efímeros).

En ambos casos **sólo hay que vincular una vez**.

### Opción A: Código QR (local)

1. Dejá `PHONE_NUMBER` vacío en `.env`.
2. `npm start` → aparece un QR en la consola.
3. En el teléfono del bot: **WhatsApp → ⋮ / Configuración → Dispositivos vinculados → Vincular dispositivo** y escaneá el QR.

### Opción B: Pairing Code (servidores remotos, sin escanear)

1. En `.env` (o en el panel de Render) poné el número del bot en formato internacional, **sólo dígitos** (sin `+`, espacios ni guiones):
   ```env
   PHONE_NUMBER=5491112345678
   ```
2. Iniciá el bot → la consola/logs muestran un código de 8 caracteres (ej: `ABCD-EFGH`).
3. En el teléfono del bot: **Dispositivos vinculados → Vincular dispositivo → "Vincular con número de teléfono"** e ingresá el código.

Una vez vinculado, `PHONE_NUMBER` ya no se usa (podés dejarlo o borrarlo).

### Si se desvincula

Si cerrás la sesión desde el teléfono, el bot muestra un aviso *logged out* y deja de reconectar:
- **Con MongoDB:** el bot limpia automáticamente la colección `baileys_auth`; sólo reiniciá el servicio para volver a vincular.
- **En local:** borrá la carpeta `auth_info` y volvé a iniciar:
  ```bash
  rm -rf auth_info        # PowerShell: Remove-Item -Recurse -Force auth_info
  npm start
  ```

## Deploy en Render (Free Tier + MongoDB Atlas)

Render Free Tier borra el disco local en cada reinicio/deploy y limita la RAM a **512 MB**. Para correr 24/7 gratis:

1. **Creá una base en MongoDB Atlas (plan Free M0):**
   - Permití acceso de red desde cualquier IP (`0.0.0.0/0`) porque Render Free no tiene IPs fijas.
   - Copiá la URI de conexión (ej: `mongodb+srv://usuario:clave@cluster.mongodb.net/botwsp?retryWrites=true&w=majority`).
2. **Creá un Web Service en Render:**
   - Conectá el repo y elegí entorno **Docker** (usa el `Dockerfile` del proyecto, sin volúmenes obligatorios).
   - Corré **una sola instancia** (dos instancias con la misma sesión se desconectan entre sí).
3. **Configurá estas variables de entorno en Render:**
   - `MONGODB_URI` *(obligatoria)*: tu URI de MongoDB Atlas.
   - `PHONE_NUMBER` *(para vincular sin QR)*: número del bot en dígitos (ej: `5491112345678`).
   - `STICKER_PACK`: nombre del pack (ej: `X Stickers`).
   - `STICKER_AUTHOR`: autor del pack (ej: `MiBot`).
   - `ALLOW_GROUPS`: `false` (o `true` si querés usarlo en grupos).
   - `LOG_LEVEL`: `info` (opcional).
4. **Mantené el servicio despierto con UptimeRobot:**
   - Render Free suspende el servicio tras 15 minutos sin tráfico HTTP.
   - Creá un monitor HTTP(S) en [UptimeRobot](https://uptimerobot.com/) apuntando a `https://<tu-app>.onrender.com/health` cada **5 minutos**.
   - El endpoint `GET /health` responde rápido con `200 OK` y `{ "status": "ok", "whatsapp": "connected" | "connecting", ... }`.

## Docker (local)

```bash
cp .env.example .env
docker compose up -d --build
docker compose logs -f bot      # para ver el QR / pairing code la primera vez
```

- En local con `docker-compose.yml`, si dejás `MONGODB_URI` vacío, la sesión se guarda en el volumen `auth_info`.
- Para revincular desde cero en local: `docker compose down -v` (borra el volumen) y volvé a levantar.
- La imagen usa `node:20-slim` (según la spec). Para otra versión: `docker compose build --build-arg NODE_VERSION=22`.

## Configuración (`.env`)

| Variable | Default | Descripción |
|---|---|---|
| `PORT` | `3000` | Puerto del servidor HTTP (`/health`; Render lo inyecta automáticamente) |
| `AUTH_DIR` | `./auth_info` | Carpeta local de sesión cuando no se usa `MONGODB_URI` |
| `MONGODB_URI` | _(vacío)_ | URI de MongoDB Atlas; si se define, guarda la sesión en MongoDB |
| `STICKER_PACK` | `X Stickers` | Nombre del pack que muestra WhatsApp |
| `STICKER_AUTHOR` | `MiBot` | Autor del pack |
| `ALLOW_GROUPS` | `false` | `true` para que el bot también responda en grupos |
| `PHONE_NUMBER` | _(vacío)_ | Número del bot para vincular por Pairing Code |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` |

## Uso

| Mensaje | Respuesta |
|---|---|
| `/start` o `/ayuda` | Breve explicación de cómo usar el bot |
| Link de X/Twitter | Sticker (hasta 3 links por mensaje) |
| Cualquier otro mensaje | Se ignora (para no spamear) |

Links soportados: `x.com`, `twitter.com`, `mobile.twitter.com`, `fxtwitter.com`, `vxtwitter.com`, con o sin `/photo/1`, `/video/1` o parámetros (`?s=20`).

## Estructura

```text
src/
├── index.js              # Entrypoint: servidor /health + cliente WhatsApp + apagado limpio
├── config.js             # Variables de entorno validadas
├── whatsapp/
│   ├── client.js         # Conexión Baileys híbrida (MongoDB/local), reconexión, QR / Pairing Code
│   ├── mongoAuthState.js # Adaptador de sesión de Baileys en MongoDB (colección baileys_auth)
│   └── handler.js        # Mensajes, comandos, reacciones y respuestas
├── services/
│   ├── twitter.js        # FxTwitter + fallback VxTwitter
│   └── sticker.js        # Descarga, FFmpeg adaptativo (-threads 1), EXIF, cola (máx 1)
└── utils/                # temp, errores, logger, limitador de concurrencia
scripts/
├── test-twitter.js       # npm run test:twitter <url>
└── check-syntax.js       # npm run check
```

## Límites y protección

- Descargas de más de **25 MB** se rechazan; timeouts de **30 s** en red y FFmpeg.
- **1 conversión a la vez** (`concurrencia = 1`) y FFmpeg limitado a `-threads 1` para operar cómodo en 512 MB de RAM; hasta 3 trabajos pendientes por chat.
- Compresión adaptativa: 15 fps / q65 / 8 s → 12 fps / q45 / 6 s → 10 fps / q30 / 5 s a 384 px.
- Los archivos temporales se borran siempre, salga bien o mal.
- Mensajes con más de 10 minutos de antigüedad (que llegan al reconectar) se ignoran.

> ⚠️ Baileys es una librería no oficial de WhatsApp. Usá un número dedicado y evitá usos masivos para reducir el riesgo de bloqueo.
