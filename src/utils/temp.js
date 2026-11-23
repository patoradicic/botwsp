import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import config from '../config.js';

/**
 * Asegura que exista el directorio temporal del proyecto.
 */
export async function ensureTmpDir() {
  await mkdir(config.tmpDir, { recursive: true });
  return config.tmpDir;
}

/**
 * Devuelve una ruta única dentro de tmp/ (no crea el archivo).
 * @param {string} ext extensión con o sin punto (ej: 'mp4', '.webp')
 */
export async function tempPath(ext = '') {
  await ensureTmpDir();
  const suffix = ext ? (ext.startsWith('.') ? ext : `.${ext}`) : '';
  return path.join(config.tmpDir, `${Date.now()}-${randomUUID()}${suffix}`);
}

/**
 * Borra uno o varios archivos ignorando los que no existen.
 * Nunca lanza: los errores se reportan con el logger opcional.
 */
export async function safeDelete(paths, logger) {
  const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  await Promise.all(
    list.map(async (file) => {
      // Defensa: sólo borra archivos dentro de tmp/
      const resolved = path.resolve(file);
      if (!resolved.startsWith(path.resolve(config.tmpDir) + path.sep)) {
        logger?.warn?.({ file }, 'safeDelete: ruta fuera de tmp/, se ignora');
        return;
      }
      try {
        await rm(resolved, { force: true });
      } catch (err) {
        logger?.warn?.({ err, file }, 'No se pudo borrar archivo temporal');
      }
    })
  );
}
