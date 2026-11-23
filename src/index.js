import http from 'node:http';
import config from './config.js';
import { conversionQueue } from './services/sticker.js';
import logger from './utils/logger.js';
import { ensureTmpDir } from './utils/temp.js';
import { createWhatsAppClient } from './whatsapp/client.js';
import { createMessageHandler } from './whatsapp/handler.js';

const startedAt = Date.now();

const whatsapp = createWhatsAppClient({
  onMessages: createMessageHandler({ logger }),
  logger,
});

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && pathname === '/health') {
    // Siempre 200 mientras el proceso esté vivo (requisito de Render/Railway/Koyeb/Fly.io).
    // El estado real de WhatsApp va en el cuerpo para monitoreo.
    const body = JSON.stringify({
      status: 'ok',
      whatsapp: whatsapp.status,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      conversions: { active: conversionQueue.active, pending: conversionQueue.pending },
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }

  if (req.method === 'GET' && pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('X Sticker Bot funcionando. Healthcheck en /health');
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

async function main() {
  await ensureTmpDir();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '0.0.0.0', resolve);
  });
  logger.info({ port: config.port }, `Healthcheck escuchando en http://localhost:${config.port}/health`);
  logger.info(
    {
      allowGroups: config.allowGroups,
      pairing: Boolean(config.phoneNumber),
      authMode: config.mongodbUri ? 'mongodb' : 'local',
      ...(config.mongodbUri ? {} : { authDir: config.authDir }),
    },
    'Iniciando cliente de WhatsApp'
  );

  await whatsapp.start();
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Apagando el bot…');

  const force = setTimeout(() => {
    logger.warn('Cierre forzado tras 10s');
    process.exit(1);
  }, 10_000);
  force.unref();

  await whatsapp.stop();
  await new Promise((resolve) => server.close(() => resolve()));
  logger.info('Bot detenido correctamente');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'Promesa rechazada sin manejar'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Excepción no capturada');
  process.exit(1);
});

main().catch((err) => {
  logger.fatal({ err }, 'No se pudo iniciar el bot');
  process.exit(1);
});
