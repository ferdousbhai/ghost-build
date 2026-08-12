import { cloudflare } from '@cloudflare/vite-plugin';
import agents from 'agents/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';
import { optimizeCssModules } from 'vite-plugin-optimize-css-modules';
import wasm from 'vite-plugin-wasm';
import { fileURLToPath } from 'node:url';
import { readFile, rm, writeFile } from 'node:fs/promises';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const CLIENT_ASSETS_IGNORE_PATH = fromRoot('./dist/client/.assetsignore');

export function withPrivateClientSourceMaps(content: string): string {
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (!lines.includes('*.map')) {
    lines.push('*.map');
  }
  return `${lines.join('\n')}\n`;
}

export default defineConfig((config) => {
  const isTest = config.mode === 'test';

  return {
    build: {
      // this enabled top-level await
      target: 'esnext',
      // our source isn't very secret, but this does make it very important not to harcode secrets:
      // sourcemaps may include backend code!
      sourcemap: true,
      rolldownOptions: {
        output: {
          format: 'esm',
        },
      },
      commonjsOptions: {
        transformMixedEsModules: true,
      },
    },
    optimizeDeps: {
      include: ['react-dom'],
    },
    define: {
      global: 'globalThis',
    },
    resolve: {
      tsconfigPaths: true,
      alias: isTest ? { 'cloudflare:workers': fromRoot('./app/test/cloudflare-workers-shim.ts') } : undefined,
    },
    ssr: {
      noExternal: isTest
        ? ['@cloudflare/sandbox', '@cloudflare/containers', 'agents', '@cloudflare/codemode']
        : undefined,
    },
    test: {
      exclude: [...configDefaults.exclude, 'e2e/**'],
    },
    plugins: [
      !isTest && agents(),
      {
        name: 'ghostbuild-strip-local-dev-vars',
        apply: 'build',
        async closeBundle() {
          await rm(fromRoot('./dist/server/.dev.vars'), { force: true });
        },
      },
      !isTest && cloudflare({ viteEnvironment: { name: 'ssr' } }),
      {
        name: 'ghostbuild-private-client-source-maps',
        apply: 'build',
        enforce: 'post',
        async closeBundle() {
          const generatedIgnore = await readFile(CLIENT_ASSETS_IGNORE_PATH, 'utf8');
          await writeFile(CLIENT_ASSETS_IGNORE_PATH, withPrivateClientSourceMaps(generatedIgnore));
        },
      },
      !isTest &&
        tanstackStart({
          srcDirectory: 'app',
          router: {
            routesDirectory: 'routes',
            generatedRouteTree: 'routeTree.gen.ts',
            quoteStyle: 'single',
            semicolons: true,
          },
        }),
      react(),
      config.mode === 'production' && optimizeCssModules({ apply: 'build' }),
      wasm(),
    ].filter(Boolean),
    envPrefix: ['VITE_'],
  };
});
