import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import webpmux from 'node-webpmux';
import config from '../config.js';
import { ErrorCodes, UserFacingError } from '../utils/errors.js';
import { createLimiter } from '../utils/limiter.js';
import { safeDelete, tempPath } from '../utils/temp.js';

const execFileAsync = promisify(execFile);
const { Image } = webpmux;

const SIZE = config.stickerSize; // 512

// Hosts desde los que aceptamos descargar media (evita SSRF con URLs arbitrarias)
const ALLOWED_MEDIA_HOSTS = ['twimg.com', 'fxtwitter.com', 'vxtwitter.com', 'fixupx.com', 'fixvx.com'];

/** Estrategia adaptativa para stickers animados (siempre respetando la proporción original). */
export const ANIMATED_ATTEMPTS = Object.freeze([
  { fps: 15, quality: 65, maxDuration: 8, scale: 512 },
  { fps: 12, quality: 45, maxDuration: 6, scale: 512 },
  { fps: 10, quality: 30, maxDuration: 5, scale: 384 },
]);

// WhatsApp limita los stickers estáticos a 100 KB
const STATIC_MAX_BYTES = 100 * 1024;
const STATIC_QUALITIES = [80, 60, 40, 25];

const limit = createLimiter(config.maxConcurrentConversions);

// ---------------------------------------------------------------------------
// Descarga
// ---------------------------------------------------------------------------

function assertAllowedUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new UserFacingError(ErrorCodes.NO_MEDIA, 'El tuit devolvió una URL de media inválida.');
  }
  const okHost = ALLOWED_MEDIA_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
  if (u.protocol !== 'https:' || !okHost) {
    throw new UserFacingError(
      ErrorCodes.NO_MEDIA,
      'La media del tuit está alojada en un sitio no soportado.',
      { cause: new Error(`Host no permitido: ${u.protocol}//${u.hostname}`) }
    );
  }
}

function tooLargeError(bytes) {
  const mb = bytes ? ` (${(bytes / 1024 / 1024).toFixed(1)} MB)` : '';
  return new UserFacingError(
    ErrorCodes.TOO_LARGE,
    `El archivo del tuit es demasiado grande${mb}. El máximo es ${Math.round(config.maxDownloadBytes / 1024 / 1024)} MB.`
  );
}

/**
 * Descarga una URL a disco con timeout y límite de tamaño (Content-Length + conteo en streaming).
 */
export async function downloadToFile(url, dest) {
  assertAllowedUrl(url);
  const max = config.maxDownloadBytes;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(config.fetchTimeoutMs),
      headers: { 'User-Agent': 'x-sticker-bot/1.0' },
      redirect: 'follow',
    });
    if (!res.ok || !res.body) {
      throw new UserFacingError(
        ErrorCodes.NETWORK,
        'No pude descargar el archivo del tuit. Probá de nuevo en un rato.',
        { cause: new Error(`Descarga HTTP ${res.status}`) }
      );
    }

    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > max) {
      await res.body.cancel().catch(() => {});
      throw tooLargeError(declared);
    }

    let received = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        received += chunk.length;
        if (received > max) cb(tooLargeError(received));
        else cb(null, chunk);
      },
    });

    await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(dest));
    return received;
  } catch (err) {
    if (err instanceof UserFacingError) throw err;
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new UserFacingError(
        ErrorCodes.TIMEOUT,
        'La descarga del archivo tardó demasiado. Probá de nuevo en un rato.',
        { cause: err }
      );
    }
    throw new UserFacingError(
      ErrorCodes.NETWORK,
      'No pude descargar el archivo del tuit (error de red).',
      { cause: err }
    );
  }
}

// ---------------------------------------------------------------------------
// FFmpeg
// ---------------------------------------------------------------------------

async function runFfmpeg(args) {
  try {
    await execFileAsync(config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-y', ...args], {
      timeout: config.ffmpegTimeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new UserFacingError(
        ErrorCodes.CONVERSION,
        'El servidor no tiene FFmpeg instalado, no puedo convertir el sticker.',
        { cause: err }
      );
    }
    if (err?.killed || err?.signal === 'SIGKILL') {
      throw new UserFacingError(
        ErrorCodes.TIMEOUT,
        'La conversión tardó demasiado. Probá con un GIF o video más corto.',
        { cause: err }
      );
    }
    throw new UserFacingError(
      ErrorCodes.CONVERSION,
      'No pude convertir ese archivo a sticker.',
      { cause: new Error(String(err?.stderr || err?.message || err).trim().slice(0, 500)) }
    );
  }
}

/**
 * Filtro que respeta la proporción original: escala el lado más largo a `scale`
 * y rellena el lienzo 512x512 con transparencia real (sin crop ni deformación).
 */
export function buildFilter({ scale = SIZE, fps } = {}) {
  const parts = [];
  if (fps) parts.push(`fps=${fps}`);
  parts.push(
    'format=rgba',
    `scale=${scale}:${scale}:force_original_aspect_ratio=decrease`,
    `pad=${SIZE}:${SIZE}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`
  );
  return parts.join(',');
}

async function convertAnimated(input, output, attempt) {
  await runFfmpeg([
    '-t', String(attempt.maxDuration), // recorta la entrada a los primeros N segundos
    '-i', input,
    '-vf', buildFilter(attempt),
    '-threads', '1',
    '-an',
    '-c:v', 'libwebp',
    '-pix_fmt', 'yuva420p',
    '-lossless', '0',
    '-quality', String(attempt.quality),
    '-compression_level', '4',
    '-loop', '0',
    '-f', 'webp',
    output,
  ]);
}

async function convertStatic(input, output, quality) {
  await runFfmpeg([
    '-i', input,
    '-vf', buildFilter(),
    '-threads', '1',
    '-frames:v', '1',
    '-an',
    '-c:v', 'libwebp',
    '-pix_fmt', 'yuva420p',
    '-lossless', '0',
    '-quality', String(quality),
    '-compression_level', '6',
    '-f', 'webp',
    output,
  ]);
}

// ---------------------------------------------------------------------------
// EXIF (metadatos de pack / autor que muestra WhatsApp)
// ---------------------------------------------------------------------------

export async function addStickerExif(webpBuffer, { pack = config.stickerPack, author = config.stickerAuthor } = {}) {
  const img = new Image();
  await img.load(webpBuffer);

  const json = {
    'sticker-pack-id': `x-sticker-bot-${randomUUID()}`,
    'sticker-pack-name': pack,
    'sticker-pack-publisher': author,
    emojis: ['🎞️'],
  };
  const exifAttr = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x16, 0x00, 0x00, 0x00,
  ]);
  const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
  const exif = Buffer.concat([exifAttr, jsonBuffer]);
  exif.writeUIntLE(jsonBuffer.length, 14, 4);

  img.exif = exif;
  return img.save(null);
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} StickerResult
 * @property {Buffer} buffer   .webp final con EXIF, listo para enviar
 * @property {boolean} animated
 * @property {number} size     bytes
 * @property {number} attempt  intento (1-based) que produjo el resultado
 * @property {number} downloadedBytes
 */

async function createStickerUnlimited(media, { logger, pack, author } = {}) {
  const animated = media.type === 'gif' || media.type === 'video';
  const input = await tempPath(animated ? 'mp4' : 'img');
  const output = await tempPath('webp');

  try {
    const downloadedBytes = await downloadToFile(media.url, input);
    logger?.debug?.({ type: media.type, downloadedBytes }, 'Media descargada');

    const attempts = animated ? ANIMATED_ATTEMPTS : STATIC_QUALITIES.map((quality) => ({ quality }));
    const threshold = animated ? config.stickerRetryThresholdBytes : STATIC_MAX_BYTES;
    const hardLimit = animated ? config.stickerMaxBytes : STATIC_MAX_BYTES;

    let size = 0;
    let used = 0;
    for (let i = 0; i < attempts.length; i++) {
      used = i + 1;
      if (animated) await convertAnimated(input, output, attempts[i]);
      else await convertStatic(input, output, attempts[i].quality);

      size = (await stat(output)).size;
      logger?.debug?.({ attempt: used, size, params: attempts[i] }, 'Intento de conversión');
      if (size <= threshold) break;
    }

    if (size > hardLimit) {
      throw new UserFacingError(
        ErrorCodes.TOO_LARGE,
        'No pude comprimir el sticker por debajo del límite de WhatsApp. Probá con un GIF más corto o simple.'
      );
    }

    const buffer = await addStickerExif(await readFile(output), { pack, author });
    if (buffer.length > hardLimit) {
      throw new UserFacingError(ErrorCodes.TOO_LARGE, 'El sticker quedó demasiado pesado para WhatsApp.');
    }

    return { buffer, animated, size: buffer.length, attempt: used, downloadedBytes };
  } finally {
    await safeDelete([input, output], logger);
  }
}

/**
 * Descarga la media de un tuit y la convierte en sticker de WhatsApp.
 * Limitado a `config.maxConcurrentConversions` ejecuciones simultáneas.
 * @param {import('./twitter.js').TweetMedia} media
 * @returns {Promise<StickerResult>}
 */
export function createSticker(media, opts) {
  return limit(() => createStickerUnlimited(media, opts));
}

export const conversionQueue = limit;
