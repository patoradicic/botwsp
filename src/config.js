import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(ROOT_DIR, '.env'), quiet: true });

const VALID_LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

function str(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function bool(name, fallback = false) {
  const value = str(name).toLowerCase();
  if (!value) return fallback;
  if (['true', '1', 'yes', 'si', 'sí'].includes(value)) return true;
  if (['false', '0', 'no'].includes(value)) return false;
  throw new Error(`Variable ${name} inválida: "${process.env[name]}" (usá true/false)`);
}

function int(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = str(name);
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Variable ${name} inválida: "${raw}" (entero entre ${min} y ${max})`);
  }
  return value;
}

function phone(name) {
  const raw = str(name);
  if (!raw) return '';
  const digits = raw.replace(/[\s()+-]/g, '');
  if (!/^\d{8,15}$/.test(digits)) {
    throw new Error(
      `Variable ${name} inválida: usá formato internacional sólo con dígitos (ej: 5491112345678)`
    );
  }
  return digits;
}

function logLevel(name, fallback) {
  const value = str(name, fallback).toLowerCase();
  if (!VALID_LOG_LEVELS.includes(value)) {
    throw new Error(`Variable ${name} inválida: "${value}" (opciones: ${VALID_LOG_LEVELS.join(', ')})`);
  }
  return value;
}

export const config = Object.freeze({
  port: int('PORT', 3000, { min: 1, max: 65535 }),
  authDir: path.resolve(ROOT_DIR, str('AUTH_DIR', './auth_info')),
  stickerPack: str('STICKER_PACK', 'X Stickers'),
  stickerAuthor: str('STICKER_AUTHOR', 'MiBot'),
  allowGroups: bool('ALLOW_GROUPS', false),
  phoneNumber: phone('PHONE_NUMBER'),
  logLevel: logLevel('LOG_LEVEL', 'info'),

  tmpDir: path.join(ROOT_DIR, 'tmp'),

  // Límites de seguridad
  maxDownloadBytes: 25 * 1024 * 1024, // 25 MB
  fetchTimeoutMs: 30_000,
  ffmpegTimeoutMs: 30_000,
  maxConcurrentConversions: 2,

  // Sticker
  stickerSize: 512,
  stickerMaxBytes: 500 * 1024, // límite duro de WhatsApp
  stickerRetryThresholdBytes: 480 * 1024, // si supera esto, reintenta con más compresión
  ffmpegPath: str('FFMPEG_PATH', 'ffmpeg'),
});

export default config;
