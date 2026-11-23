#!/usr/bin/env node
/**
 * Prueba local de extracción + conversión sin conectar WhatsApp.
 *
 * Uso:
 *   npm run test:twitter -- <url_del_tuit>
 *   npm run test:twitter <url_del_tuit>
 *
 * Genera el sticker en ./output/ y muestra un resumen.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import webpmux from 'node-webpmux';
import { ROOT_DIR } from '../src/config.js';
import { createSticker } from '../src/services/sticker.js';
import { getTweetMedia, parseTweetUrl } from '../src/services/twitter.js';
import { toUserMessage } from '../src/utils/errors.js';
import logger from '../src/utils/logger.js';

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

async function main() {
  const input = process.argv.slice(2).join(' ').trim();
  if (!input) {
    console.error('Uso: npm run test:twitter -- <url_del_tuit>');
    console.error('Ej:  npm run test:twitter -- https://x.com/usuario/status/1234567890');
    process.exit(2);
  }

  const parsed = parseTweetUrl(input);
  if (!parsed) {
    console.error('❌ No reconocí un link de X/Twitter en:', input);
    process.exit(2);
  }
  console.log(`🔗 Tuit: @${parsed.username} / ${parsed.tweetId}${parsed.mediaIndex ? ` (media #${parsed.mediaIndex})` : ''}`);

  const t0 = performance.now();
  const info = await getTweetMedia(parsed, { logger });
  const t1 = performance.now();
  console.log(`📥 Proveedor: ${info.provider} · autor: @${info.author} · ${info.allMedia.length} media(s)`);
  console.log(
    `🎞️  Elegida: ${info.media.type}` +
      (info.media.width ? ` ${info.media.width}x${info.media.height}` : '') +
      (info.media.duration ? ` · ${info.media.duration.toFixed(1)}s` : '')
  );
  console.log(`   ${info.media.url}`);

  const result = await createSticker(info.media, { logger });
  const t2 = performance.now();

  const outDir = path.join(ROOT_DIR, 'output');
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, `sticker-${info.tweetId}.webp`);
  await writeFile(outFile, result.buffer);

  // Verificación del archivo generado
  const img = new webpmux.Image();
  await img.load(result.buffer);
  const frames = img.hasAnim ? img.frames.length : 1;
  const exifJson = img.exif ? img.exif.subarray(22).toString('utf8') : null;

  const checks = [
    ['Dimensiones 512x512', img.width === 512 && img.height === 512, `${img.width}x${img.height}`],
    ['Peso < 500 KB', result.size < 500 * 1024, kb(result.size)],
    ...(result.animated ? [] : [['Peso estático <= 100 KB', result.size <= 100 * 1024, kb(result.size)]]),
    ['Tipo', true, result.animated ? `animado (${frames} frames)` : 'estático'],
    ['EXIF pack/autor', Boolean(exifJson), exifJson ?? 'sin EXIF'],
  ];

  console.log('\n✅ Sticker generado:', outFile);
  console.log(`   Descarga: ${kb(result.downloadedBytes)} · intento de compresión: ${result.attempt}`);
  console.log(`   Tiempos: extracción ${((t1 - t0) / 1000).toFixed(1)}s · conversión ${((t2 - t1) / 1000).toFixed(1)}s`);
  for (const [name, ok, detail] of checks) console.log(`   ${ok ? '✔' : '✘'} ${name}: ${detail}`);

  if (checks.some(([, ok]) => !ok)) process.exit(1);
}

main().catch((err) => {
  console.error(`\n❌ ${toUserMessage(err)}`);
  if (err?.code) console.error(`   código: ${err.code}`);
  if (err?.cause) console.error(`   detalle: ${err.cause.message ?? err.cause}`);
  else if (!err?.code) console.error(err);
  process.exit(1);
});
