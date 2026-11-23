import config from '../config.js';
import { ErrorCodes, UserFacingError } from '../utils/errors.js';

const USER_AGENT = 'x-sticker-bot/1.0 (+https://github.com/; WhatsApp sticker bot)';

/**
 * Detecta links de tuits en texto libre.
 * Soporta x.com, twitter.com, mobile.twitter.com, fxtwitter.com, vxtwitter.com
 * (y fixupx/fixvx), con o sin esquema, con /photo/N, /video/N y query params.
 *
 * Grupos: 1 = usuario (o undefined si es /i/web/status), 2 = id del tuit,
 *         3 = tipo de media indicado (photo|video), 4 = índice de media (1-based)
 */
const TWEET_URL_REGEX =
  /(?<![\w.-])(?:https?:\/\/)?(?:www\.|mobile\.|m\.)?(?:x|twitter|fxtwitter|vxtwitter|fixupx|fixvx)\.com\/(?:#!\/)?(?:i\/web|([A-Za-z0-9_]{1,15}))\/status(?:es)?\/(\d{1,25})(?:\/(photo|video)\/(\d))?[^\s]*/gi;

/**
 * Busca todos los links de tuits en un texto.
 * @returns {{ url: string, username: string, tweetId: string, mediaIndex: number|null }[]}
 */
export function findTweetUrls(text) {
  if (!text || typeof text !== 'string') return [];
  const results = [];
  const seen = new Set();
  for (const match of text.matchAll(TWEET_URL_REGEX)) {
    const [url, username, tweetId, , index] = match;
    if (seen.has(tweetId)) continue;
    seen.add(tweetId);
    results.push({
      url,
      username: username || 'i',
      tweetId,
      mediaIndex: index ? Number(index) : null,
    });
  }
  return results;
}

/**
 * Parsea un único link de tuit. Devuelve null si no es válido.
 */
export function parseTweetUrl(text) {
  return findTweetUrls(text)[0] ?? null;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function fetchJson(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(config.fetchTimeoutMs),
      redirect: 'follow',
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new UserFacingError(
        ErrorCodes.TIMEOUT,
        'X tardó demasiado en responder. Probá de nuevo en un rato.',
        { cause: err }
      );
    }
    throw new UserFacingError(
      ErrorCodes.NETWORK,
      'No pude conectarme para leer el tuit (error de red). Probá de nuevo en un rato.',
      { cause: err }
    );
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    // respuesta no JSON (ej: página de error HTML)
  }
  return { status: res.status, ok: res.ok, body };
}

// ---------------------------------------------------------------------------
// Normalización
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} TweetMedia
 * @property {'gif'|'video'|'photo'} type
 * @property {string} url URL directa del archivo (.mp4 o imagen)
 * @property {number|null} duration Duración en segundos (si se conoce)
 * @property {number|null} width
 * @property {number|null} height
 */

/**
 * @typedef {Object} TweetMediaResult
 * @property {string} tweetId
 * @property {string} author
 * @property {string} provider 'fxtwitter' | 'vxtwitter'
 * @property {TweetMedia} media Media elegida para el sticker
 * @property {TweetMedia[]} allMedia
 */

const MAX_PREFERRED_BITRATE = 2_500_000; // ~720p: suficiente para 512px y liviano de descargar

/** Elige la variante mp4 más adecuada (no hace falta 1080p para un sticker de 512px). */
function pickMp4Variant(variants, fallbackUrl) {
  const mp4s = (variants || []).filter(
    (v) => v?.url && (v.content_type === 'video/mp4' || /\.mp4(\?|$)/.test(v.url)) && v.bitrate !== undefined
  );
  if (mp4s.length === 0) return fallbackUrl;
  const sorted = [...mp4s].sort((a, b) => (a.bitrate ?? 0) - (b.bitrate ?? 0));
  const underCap = sorted.filter((v) => (v.bitrate ?? 0) <= MAX_PREFERRED_BITRATE);
  return (underCap.at(-1) ?? sorted[0]).url;
}

/** Pide a pbs.twimg.com un tamaño razonable en lugar del original gigante. */
function optimizePhotoUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'pbs.twimg.com' && u.pathname.startsWith('/media/')) {
      const ext = u.pathname.match(/\.(jpe?g|png|webp)$/i)?.[1];
      if (ext) {
        u.pathname = u.pathname.replace(/\.(jpe?g|png|webp)$/i, '');
        u.searchParams.set('format', ext.toLowerCase() === 'jpeg' ? 'jpg' : ext.toLowerCase());
      }
      u.searchParams.set('name', 'medium');
      return u.toString();
    }
  } catch {
    /* URL inválida: se usa tal cual */
  }
  return url;
}

function normalizeFxMedia(item) {
  if (!item?.url) return null;
  if (item.type === 'video' || item.type === 'gif') {
    return {
      type: item.type,
      url: item.type === 'video' ? pickMp4Variant(item.variants, item.url) : item.url,
      duration: typeof item.duration === 'number' ? item.duration : null,
      width: item.width ?? null,
      height: item.height ?? null,
    };
  }
  if (item.type === 'photo') {
    return {
      type: 'photo',
      url: optimizePhotoUrl(item.url),
      duration: null,
      width: item.width ?? null,
      height: item.height ?? null,
    };
  }
  return null;
}

function normalizeVxMedia(item) {
  if (!item?.url) return null;
  const type = item.type === 'image' ? 'photo' : item.type;
  if (!['video', 'gif', 'photo'].includes(type)) return null;
  return {
    type,
    url: type === 'photo' ? optimizePhotoUrl(item.url) : item.url,
    duration: typeof item.duration_millis === 'number' ? item.duration_millis / 1000 : null,
    width: item.size?.width ?? null,
    height: item.size?.height ?? null,
  };
}

/**
 * Elige qué media usar: respeta /photo/N o /video/N si existe;
 * si no, prioriza video/GIF sobre imágenes.
 */
function chooseMedia(allMedia, mediaIndex) {
  if (allMedia.length === 0) return null;
  if (mediaIndex && allMedia[mediaIndex - 1]) return allMedia[mediaIndex - 1];
  return allMedia.find((m) => m.type === 'gif' || m.type === 'video') ?? allMedia[0];
}

function noMediaError() {
  return new UserFacingError(
    ErrorCodes.NO_MEDIA,
    'Ese tuit no tiene GIF, video ni imagen para convertir en sticker.'
  );
}

function notFoundError() {
  return new UserFacingError(
    ErrorCodes.NOT_FOUND,
    'No encontré ese tuit. Puede que haya sido borrado o que el link esté mal.'
  );
}

function privateError() {
  return new UserFacingError(
    ErrorCodes.PRIVATE,
    'Ese tuit es de una cuenta privada o protegida, no puedo acceder al contenido.'
  );
}

function providerError(provider, status) {
  return new UserFacingError(
    ErrorCodes.NETWORK,
    'El servicio para leer tuits no está respondiendo bien. Probá de nuevo en un rato.',
    { cause: new Error(`${provider} respondió HTTP ${status}`) }
  );
}

// ---------------------------------------------------------------------------
// Proveedores
// ---------------------------------------------------------------------------

async function fromFxTwitter({ username, tweetId }) {
  const url = `https://api.fxtwitter.com/${encodeURIComponent(username)}/status/${tweetId}`;
  const { status, body } = await fetchJson(url);

  if (status === 401 || body?.message === 'PRIVATE_TWEET') throw privateError();
  if (status === 404 || body?.message === 'NOT_FOUND') throw notFoundError();
  if (status !== 200 || !body?.tweet) throw providerError('fxtwitter', status);

  const tweet = body.tweet;
  let items = tweet.media?.all ?? [...(tweet.media?.videos ?? []), ...(tweet.media?.photos ?? [])];
  // Si el tuit no tiene media pero cita a otro que sí, usamos la del citado
  if (items.length === 0 && tweet.quote?.media) {
    items = tweet.quote.media.all ?? [...(tweet.quote.media.videos ?? []), ...(tweet.quote.media.photos ?? [])];
  }

  return {
    author: tweet.author?.screen_name ?? username,
    allMedia: items.map(normalizeFxMedia).filter(Boolean),
  };
}

async function fromVxTwitter({ username, tweetId }) {
  const url = `https://api.vxtwitter.com/${encodeURIComponent(username)}/status/${tweetId}`;
  const { status, body } = await fetchJson(url);

  const errorText = String(body?.error ?? '').toLowerCase();
  if (status === 401 || errorText.includes('private') || errorText.includes('protected')) {
    throw privateError();
  }
  if (status === 404 || errorText.includes('not found') || errorText.includes('failed to scan')) {
    throw notFoundError();
  }
  if (status !== 200 || !body || body.error) throw providerError('vxtwitter', status);

  let items = body.media_extended ?? [];
  if (items.length === 0 && body.qrt?.media_extended?.length) items = body.qrt.media_extended;

  return {
    author: body.user_screen_name ?? username,
    allMedia: items.map(normalizeVxMedia).filter(Boolean),
  };
}

const PROVIDERS = [
  { name: 'fxtwitter', fn: fromFxTwitter },
  { name: 'vxtwitter', fn: fromVxTwitter },
];

// Cuando fallan todos, se reporta el error más informativo para el usuario
const ERROR_PRIORITY = [
  ErrorCodes.PRIVATE,
  ErrorCodes.NOT_FOUND,
  ErrorCodes.NO_MEDIA,
  ErrorCodes.TIMEOUT,
  ErrorCodes.NETWORK,
];

function mostInformative(errors) {
  return [...errors].sort((a, b) => {
    const pa = ERROR_PRIORITY.indexOf(a.code);
    const pb = ERROR_PRIORITY.indexOf(b.code);
    return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
  })[0];
}

/**
 * Obtiene la media de un tuit usando FxTwitter con fallback automático a VxTwitter.
 * @param {string} input link del tuit (o texto que lo contenga)
 * @param {{ logger?: import('pino').Logger }} [opts]
 * @returns {Promise<TweetMediaResult>}
 */
export async function getTweetMedia(input, { logger } = {}) {
  const parsed = typeof input === 'string' ? parseTweetUrl(input) : input;
  if (!parsed?.tweetId) {
    throw new UserFacingError(ErrorCodes.INVALID_URL, 'Eso no parece un link válido de X/Twitter.');
  }

  const errors = [];
  for (const provider of PROVIDERS) {
    try {
      const { author, allMedia } = await provider.fn(parsed);
      const media = chooseMedia(allMedia, parsed.mediaIndex);
      if (!media) throw noMediaError();
      logger?.debug?.({ provider: provider.name, tweetId: parsed.tweetId, media }, 'Media encontrada');
      return { tweetId: parsed.tweetId, author, provider: provider.name, media, allMedia };
    } catch (err) {
      const wrapped =
        err instanceof UserFacingError
          ? err
          : new UserFacingError(ErrorCodes.NETWORK, 'No pude leer el tuit. Probá de nuevo en un rato.', {
              cause: err,
            });
      logger?.warn?.(
        { provider: provider.name, tweetId: parsed.tweetId, code: wrapped.code, cause: wrapped.cause?.message },
        'Proveedor falló, probando el siguiente'
      );
      errors.push(wrapped);
    }
  }

  throw mostInformative(errors);
}
