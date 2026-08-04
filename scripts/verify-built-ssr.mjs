import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const builtServerPath = resolve(rootDir, 'dist/server/index.js');

const routeCases = [
  { path: '/', status: 200, content: 'If you can dream it' },
  { path: '/settings', status: 200, content: 'Settings | Ghostbuild' },
  { path: '/chat/ssr-smoke-project', status: 200, content: 'Project | Ghostbuild' },
  { path: '/does-not-exist', status: 404, content: 'This page does not exist' },
];

async function verifyBuiltSsr() {
  if (!existsSync(builtServerPath)) {
    throw new Error('dist/server/index.js is missing; run pnpm run build before built SSR verification.');
  }

  const moduleUrl = `${pathToFileURL(builtServerPath).href}?ssr-smoke=${Date.now()}`;
  const worker = (await import(moduleUrl)).default;
  if (!worker || typeof worker.fetch !== 'function') {
    throw new Error('The built server does not export a Worker fetch handler.');
  }

  const errors = [];
  for (const routeCase of routeCases) {
    try {
      const response = await worker.fetch(
        new Request(`https://ghostbuild.dev${routeCase.path}`, { headers: { accept: 'text/html' } }),
        {},
      );
      const body = await response.text();
      if (response.status !== routeCase.status) {
        errors.push(`${routeCase.path} returned ${response.status}; expected ${routeCase.status}.`);
      }
      if (!response.headers.get('content-type')?.startsWith('text/html')) {
        errors.push(`${routeCase.path} did not return HTML.`);
      }
      if (!body.includes(routeCase.content)) {
        errors.push(`${routeCase.path} omitted its expected SSR content: ${JSON.stringify(routeCase.content)}.`);
      }
    } catch (error) {
      errors.push(
        `${routeCase.path} failed during built SSR: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
  console.log(`Verified built SSR for ${routeCases.length} public and private route states.`);
}

await verifyBuiltSsr();
