#!/usr/bin/env node
// Verifica la sintaxis de todos los .js del proyecto (node --check).
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = ['src', 'scripts'].flatMap((dir) =>
  readdirSync(path.join(root, dir), { recursive: true })
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join(root, dir, f))
);

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log('✔', path.relative(root, file));
  } catch (err) {
    failed++;
    console.error('✘', path.relative(root, file), '\n', err.stderr?.toString());
  }
}
process.exit(failed ? 1 : 0);
