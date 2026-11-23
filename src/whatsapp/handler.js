import {
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  normalizeMessageContent,
} from '@whiskeysockets/baileys';
import config from '../config.js';
import { createSticker } from '../services/sticker.js';
import { findTweetUrls, getTweetMedia } from '../services/twitter.js';
import { toUserMessage } from '../utils/errors.js';
import baseLogger from '../utils/logger.js';

const COMMAND_REGEX = /^\s*[/!](start|ayuda|help)\b/i;
const MAX_LINKS_PER_MESSAGE = 3;
const MAX_PENDING_PER_CHAT = 3; // anti-spam: trabajos en curso por chat
const MAX_MESSAGE_AGE_S = 10 * 60; // ignora mensajes viejos que llegan al reconectar

export const HELP_TEXT =
  '👋 ¡Hola! Mandame un link de X/Twitter que tenga un *GIF*, *video* o *imagen* y te lo devuelvo como sticker.\n\n' +
  'Ej: https://x.com/usuario/status/123456789\n\n' +
  '• Los videos de más de 8 segundos se recortan.\n' +
  '• Las imágenes se convierten en sticker estático.';

export const REACTIONS = Object.freeze({ processing: '⏳', done: '✅', error: '❌' });

/** Extrae el texto de cualquier tipo de mensaje (texto, respuesta, caption). */
export function getMessageText(message) {
  const content = normalizeMessageContent(message);
  if (!content) return '';
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    ''
  );
}

function messageAgeSeconds(msg) {
  const ts = Number(msg.messageTimestamp?.toNumber?.() ?? msg.messageTimestamp ?? 0);
  return ts ? Date.now() / 1000 - ts : 0;
}

/**
 * Crea el manejador de `messages.upsert`.
 * @param {Object} [opts]
 * @param {import('pino').Logger} [opts.logger]
 * @param {boolean} [opts.allowGroups]
 * @param {Function} [opts.getTweetMedia]  inyectable para tests
 * @param {Function} [opts.createSticker]  inyectable para tests
 */
export function createMessageHandler({
  logger = baseLogger,
  allowGroups = config.allowGroups,
  getTweetMedia: fetchMedia = getTweetMedia,
  createSticker: makeSticker = createSticker,
} = {}) {
  const log = logger.child({ module: 'handler' });
  const pendingByChat = new Map();

  async function safeSend(sock, jid, content, options) {
    try {
      return await sock.sendMessage(jid, content, options);
    } catch (err) {
      log.warn({ err: err?.message, jid }, 'No se pudo enviar el mensaje');
      return null;
    }
  }

  const react = (sock, msg, emoji) =>
    safeSend(sock, msg.key.remoteJid, { react: { text: emoji, key: msg.key } });

  const reply = (sock, msg, text) => safeSend(sock, msg.key.remoteJid, { text }, { quoted: msg });

  async function processLinks(sock, msg, links) {
    const jid = msg.key.remoteJid;
    await react(sock, msg, REACTIONS.processing);

    let ok = 0;
    for (const link of links) {
      const started = Date.now();
      try {
        const { media, provider } = await fetchMedia(link, { logger: log });
        const sticker = await makeSticker(media, { logger: log });
        const sent = await sock.sendMessage(jid, { sticker: sticker.buffer }, { quoted: msg });
        if (!sent) throw new Error('sendMessage no devolvió resultado');
        ok++;
        log.info(
          {
            jid,
            tweetId: link.tweetId,
            provider,
            type: media.type,
            sizeKB: Math.round(sticker.size / 1024),
            attempt: sticker.attempt,
            ms: Date.now() - started,
          },
          'Sticker enviado'
        );
      } catch (err) {
        log.warn(
          { jid, tweetId: link.tweetId, code: err?.code, err: err?.cause?.message ?? err?.message },
          'Falló la generación del sticker'
        );
        const prefix = links.length > 1 ? `Link ${links.indexOf(link) + 1}: ` : '';
        await reply(sock, msg, `❌ ${prefix}${toUserMessage(err)}`);
      }
    }

    await react(sock, msg, ok > 0 ? REACTIONS.done : REACTIONS.error);
  }

  async function handleMessage(sock, msg) {
    const jid = msg.key?.remoteJid;
    if (!jid || !msg.message || msg.key.fromMe) return;
    if (isJidStatusBroadcast(jid) || isJidBroadcast(jid) || isJidNewsletter(jid)) return;
    if (isJidGroup(jid) && !allowGroups) return;
    if (messageAgeSeconds(msg) > MAX_MESSAGE_AGE_S) return;

    const text = getMessageText(msg.message);
    if (!text) return;

    if (COMMAND_REGEX.test(text)) {
      await reply(sock, msg, HELP_TEXT);
      return;
    }

    const links = findTweetUrls(text).slice(0, MAX_LINKS_PER_MESSAGE);
    if (links.length === 0) return; // no spamear: se ignoran mensajes sin links

    const pending = pendingByChat.get(jid) ?? 0;
    if (pending >= MAX_PENDING_PER_CHAT) {
      await reply(sock, msg, '⏳ Todavía estoy procesando tus links anteriores, esperá un momento.');
      return;
    }

    pendingByChat.set(jid, pending + 1);
    try {
      await processLinks(sock, msg, links);
    } finally {
      const left = (pendingByChat.get(jid) ?? 1) - 1;
      if (left <= 0) pendingByChat.delete(jid);
      else pendingByChat.set(jid, left);
    }
  }

  /**
   * Handler para `sock.ev.on('messages.upsert', …)`.
   * No bloquea: cada mensaje se procesa en paralelo (la conversión ya tiene su propio límite).
   */
  function onMessages({ messages, type }, sock) {
    if (type !== 'notify') return [];
    return messages.map((msg) =>
      handleMessage(sock, msg).catch((err) => log.error({ err }, 'Error inesperado procesando mensaje'))
    );
  }

  return onMessages;
}
