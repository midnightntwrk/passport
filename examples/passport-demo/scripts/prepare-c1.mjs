import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(scriptsDir, '..');
const source = resolve(appDir, 'contracts', 'passport_c1.compact');
const generated = resolve(appDir, '.generated', 'passport-c1');
const publicAssets = resolve(appDir, 'public', 'zk', 'passport-c1');

if (!existsSync(source)) throw new Error(`Passport C1 source was not found: ${source}`);

mkdirSync(dirname(generated), { recursive: true });
rmSync(generated, { recursive: true, force: true });
execFileSync('compact', ['compile', source, generated], { stdio: 'inherit' });

// The browser only receives proving assets. Generated TypeScript/JavaScript
// stays outside public/ and is imported through Vite's source graph.
rmSync(publicAssets, { recursive: true, force: true });
mkdirSync(dirname(publicAssets), { recursive: true });
cpSync(generated, publicAssets, {
  recursive: true,
  filter: (entry) => !entry.endsWith('/contract') && !entry.includes('/contract/'),
});
