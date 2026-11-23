import { mkdir } from 'node:fs/promises';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import { MongoClient } from 'mongodb';
import qrcode from 'qrcode-terminal';
import config from '../config.js';
import baseLogger from '../utils/logger.js';
import { useMongoAuthState } from './mongoAuthState.js';

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;

// Códigos de desconexión ante los cuales NO conviene reconectar solos (además de loggedOut)
const FATAL_REASONS = new Map([
  [
    DisconnectReason.connectionReplaced,
    'Otra instancia del bot se conectó con la misma sesión (connection replaced). Cerrá la otra instancia y reiniciá este proceso.',
  ],
  [
    DisconnectReason.forbidden,
    'WhatsApp rechazó la conexión (forbidden). Puede que el número esté bloqueado o restringido.',
  ],
]);

/**
 * Crea y mantiene la conexión con WhatsApp (Baileys) con reconexión automática.
 *
 * @param {Object} opts
 * @param {(upsert: { messages: any[], type: string }, sock: any) => void} opts.onMessages
 * @param {import('pino').Logger} [opts.logger]
 */
export function createWhatsAppClient({ onMessages, logger = baseLogger }) {
  const log = logger.child({ module: 'whatsapp' });
  // Baileys es muy verboso: sólo mostramos sus logs en debug/trace
  const baileysLevel = ['debug', 'trace'].includes(config.logLevel) ? config.logLevel : 'warn';
  const baileysLogger = logger.child({ module: 'baileys' }, { level: baileysLevel });

  let sock = null;
  let status = 'idle'; // idle | connecting | connected | reconnecting | logged_out | stopped | error
  let stopping = false;
  let attempts = 0;
  let reconnectTimer = null;
  let version;
  let mongoClient = null;
  let clearAuthState = null;
  let pendingCredsSave = Promise.resolve();
  let authModeLogged = false;

  async function ensureMongoClient() {
    if (mongoClient) return mongoClient;
    const client = new MongoClient(config.mongodbUri, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 15_000,
    });
    await client.connect();
    mongoClient = client;
    return mongoClient;
  }

  async function loadAuthState() {
    await pendingCredsSave;
    if (config.mongodbUri) {
      if (!authModeLogged) {
        log.info('Usando persistencia de sesión en MongoDB (colección baileys_auth)');
        authModeLogged = true;
      }
      const client = await ensureMongoClient();
      const auth = await useMongoAuthState(config.mongodbUri, { client });
      clearAuthState = auth.clearState;
      return auth;
    }

    if (!authModeLogged) {
      log.info({ authDir: config.authDir }, 'Usando persistencia de sesión local en disco');
      authModeLogged = true;
    }
    await mkdir(config.authDir, { recursive: true });
    clearAuthState = null;
    return useMultiFileAuthState(config.authDir);
  }

  async function handleLoggedOut() {
    status = 'logged_out';
    if (config.mongodbUri && clearAuthState) {
      await pendingCredsSave;
      try {
        await clearAuthState();
        const msg =
          'La sesión fue cerrada desde el teléfono (logged out). Se limpió la colección "baileys_auth" en MongoDB; reiniciá el servicio para volver a vincular WhatsApp.';
        log.error(msg);
        console.error(`\n⛔ ${msg}\n`);
      } catch (err) {
        const msg =
          'La sesión fue cerrada desde el teléfono (logged out), pero no se pudo limpiar "baileys_auth" en MongoDB. Vacía la colección manualmente y reiniciá el servicio.';
        log.error({ err }, msg);
        console.error(`\n⛔ ${msg}\n`);
      }
      return;
    }

    const msg = `La sesión fue cerrada desde el teléfono (logged out). Borrá la carpeta "${config.authDir}" y volvé a iniciar el bot para vincularlo de nuevo.`;
    log.error(msg);
    console.error(`\n⛔ ${msg}\n`);
  }

  async function resolveVersion() {
    if (version) return version;
    try {
      const latest = await Promise.race([
        fetchLatestBaileysVersion(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10_000)),
      ]);
      version = latest.version;
      log.info({ version: version.join('.'), isLatest: latest.isLatest }, 'Versión de WhatsApp Web');
    } catch (err) {
      log.warn({ err: err.message }, 'No se pudo obtener la última versión de WhatsApp Web, se usa la por defecto');
    }
    return version;
  }

  function scheduleReconnect(reason) {
    if (stopping) return;
    clearTimeout(reconnectTimer);
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempts, RECONNECT_MAX_MS);
    attempts++;
    status = 'reconnecting';
    log.warn({ reason, attempt: attempts, delayMs: delay }, 'Conexión cerrada, reintentando…');
    reconnectTimer = setTimeout(() => {
      connect().catch((err) => {
        log.error({ err }, 'Error al reconectar');
        scheduleReconnect('connect_error');
      });
    }, delay);
  }

  async function connect() {
    if (stopping) return;
    status = 'connecting';
    const { state, saveCreds } = await loadAuthState();
    const waVersion = await resolveVersion();

    const usePairingCode = Boolean(config.phoneNumber) && !state.creds.registered;
    let pairingRequested = false;

    const socket = makeWASocket({
      ...(waVersion ? { version: waVersion } : {}),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      logger: baileysLogger,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      // No pedimos historial completo, pero dejamos el sync inicial activo:
      // Baileys v7 lo necesita para obtener los mapeos LID ↔ número.
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });
    sock = socket;

    socket.ev.on('creds.update', () => {
      pendingCredsSave = pendingCredsSave
        .then(() => saveCreds())
        .catch((err) => {
          log.error({ err }, 'Error al guardar credenciales');
        });
    });

    socket.ev.on('connection.update', async (update) => {
      // Ignora eventos de sockets viejos
      if (socket !== sock) return;
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        if (usePairingCode) {
          if (!pairingRequested) {
            pairingRequested = true;
            try {
              const code = await socket.requestPairingCode(config.phoneNumber);
              const pretty = code?.match(/.{1,4}/g)?.join('-') ?? code;
              log.info(`🔑 Código de vinculación: ${pretty}`);
              console.log(
                `\n🔑 Código de vinculación para +${config.phoneNumber}: ${pretty}\n` +
                  '   En el teléfono del bot: WhatsApp → Dispositivos vinculados → Vincular dispositivo →\n' +
                  '   "Vincular con número de teléfono" e ingresá el código.\n'
              );
            } catch (err) {
              log.error({ err }, 'No se pudo pedir el código de vinculación');
            }
          }
        } else {
          console.log('\n📱 Escaneá este QR desde WhatsApp → Dispositivos vinculados → Vincular dispositivo:\n');
          qrcode.generate(qr, { small: true });
        }
      }

      if (connection === 'open') {
        attempts = 0;
        status = 'connected';
        log.info({ user: socket.user?.id }, '✅ Conectado a WhatsApp');
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (stopping) {
          status = 'stopped';
          return;
        }
        if (code === DisconnectReason.loggedOut) {
          await handleLoggedOut();
          return;
        }
        if (FATAL_REASONS.has(code)) {
          status = 'error';
          const msg = FATAL_REASONS.get(code);
          log.error({ code }, msg);
          console.error(`\n⛔ ${msg}\n`);
          return;
        }
        // restartRequired (515) es normal justo después de vincular: reconectar al instante
        if (code === DisconnectReason.restartRequired) {
          attempts = 0;
          log.info('Reinicio requerido por WhatsApp (normal tras vincular), reconectando…');
          connect().catch((err) => {
            log.error({ err }, 'Error al reconectar');
            scheduleReconnect('connect_error');
          });
          return;
        }
        scheduleReconnect(DisconnectReason[code] ?? code ?? lastDisconnect?.error?.message ?? 'desconocido');
      }
    });

    socket.ev.on('messages.upsert', (upsert) => {
      if (socket !== sock) return;
      try {
        onMessages(upsert, socket);
      } catch (err) {
        log.error({ err }, 'Error en el manejador de mensajes');
      }
    });

    return socket;
  }

  return {
    start: () => connect(),
    async stop() {
      stopping = true;
      clearTimeout(reconnectTimer);
      status = 'stopped';
      try {
        // end() cierra el WebSocket SIN desvincular la sesión (no usar logout())
        sock?.end(undefined);
      } catch {
        /* ignore */
      }
      await pendingCredsSave;
      if (mongoClient) {
        await mongoClient.close().catch(() => {});
        mongoClient = null;
      }
    },
    get status() {
      return status;
    },
    get socket() {
      return sock;
    },
  };
}
