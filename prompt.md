# Instrucciones para Claude

Sos el encargado de implementar desde cero el proyecto descrito en `SPEC.md`.

## Reglas de desarrollo
1. **Leé `SPEC.md` completo** antes de escribir código y respetá la estructura de carpetas y requerimientos técnicos definidos ahí.
2. **JavaScript moderno (ESM):** Usá `"type": "module"` en `package.json`, `async/await`, `fetch` nativo de Node 20+ (no instales `axios` ni `node-fetch` innecesariamente).
3. **Dependencias mínimas y estables:**
   - `@whiskeysockets/baileys`
   - `pino` (con nivel configurable para no inundar la consola)
   - `qrcode-terminal`
   - `node-webpmux`
   - `dotenv`
   - Para FFmpeg, preferí ejecutar `ffmpeg` directamente con `child_process.execFile` (promesificado) para evitar problemas de wrappers abandonados y tener control total de los flags y timeouts.
4. **Manejo robusto de errores y reconexión:**
   - Implementá reconexión automática en Baileys ante desconexiones (salvo `DisconnectReason.loggedOut`, donde debe avisar en consola que hay que borrar `auth_info` y volver a vincular).
   - Validá tamaños de descarga (ej: rechazar archivos remotos > 25 MB antes de procesarlos) y poné timeouts en `fetch` y `ffmpeg` (ej: 30 segundos) para evitar procesos colgados.
   - Implementá una cola simple o límite de concurrencia (máximo 2 conversiones simultáneas) para proteger la RAM del servidor.
5. **Seguridad y limpieza:**
   - Agregá `auth_info/`, `.env`, `node_modules/` y `tmp/` al `.gitignore`.
   - Nunca hardcodees números de teléfono ni credenciales.
6. **Docker y Documentación:**
   - Creá un `Dockerfile` liviano y un `docker-compose.yml` con volumen persistente para `auth_info`.
   - Escribí un `README.md` claro en español explicando:
     - Cómo correrlo en local (requisitos: Node 20 y FFmpeg).
     - Cómo vincular el número del bot (QR o Pairing Code).
     - Cómo levantarlo con Docker.

## Orden de implementación sugerido
1. Inicializar `package.json`, `.gitignore`, `.env.example` y `src/config.js`.
2. Implementar `src/services/twitter.js` (con soporte para GIFs, videos e imágenes, más fallback).
3. Implementar `src/services/sticker.js` (FFmpeg adaptativo < 500 KB + EXIF con `node-webpmux` + limpieza en `finally`).
4. Implementar `src/whatsapp/client.js` y `src/whatsapp/handler.js`.
5. Implementar `src/index.js` con el servidor `/health` y manejo de `SIGINT`/`SIGTERM`.
6. Crear `Dockerfile`, `docker-compose.yml` y `README.md`.
7. Agregar un script de prueba rápido (`npm run test:twitter <url>`) que permita probar la extracción y generación del `.webp` localmente sin necesidad de conectar WhatsApp todavía.