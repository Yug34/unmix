/* Assemble a loadable extension at extension/app.
 *
 * The page asks for /styles.css, /vendor/..., /separate.worker.js. In an
 * extension those resolve from the package root, so the copied site has to
 * sit next to manifest.json, not in a subdirectory of it. Load extension/app
 * from chrome://extensions. */

import { cpSync, mkdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(here, 'app');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

cpSync(join(root, 'static'), out, {
  recursive: true,
  filter: (src) => !src.endsWith('.onnx'),
});
cpSync(join(here, 'manifest.json'), join(out, 'manifest.json'));
cpSync(join(here, 'sandbox.html'), join(out, 'sandbox.html'));
cpSync(join(here, 'sandbox.js'), join(out, 'sandbox.js'));
cpSync(join(here, 'rules.json'), join(out, 'rules.json'));

await esbuild.build({
  entryPoints: [join(here, 'src', 'background.mjs')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  outfile: join(out, 'background.js'),
  legalComments: 'none',
  logLevel: 'info',
});

console.log(`extension ready: ${out}`);
