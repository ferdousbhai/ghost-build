import { cloudflare } from '@cloudflare/vite-plugin';
import agents from 'agents/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';
import { optimizeCssModules } from 'vite-plugin-optimize-css-modules';
import wasm from 'vite-plugin-wasm';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { fileURLToPath } from 'node:url';
import { rm } from 'node:fs/promises';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

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
      include: ['react-dom', 'react-fast-compare', 'warning', 'fuzzy'],
    },
    resolve: {
      tsconfigPaths: true,
      alias: {
        buffer: 'vite-plugin-node-polyfills/polyfills/buffer',
        ...(isTest ? { 'lz4-wasm': 'lz4-wasm/dist/index.js' } : {}),
      },
    },
    plugins: [
      !isTest && agents(),
      nodePolyfills({
        include: ['buffer', 'process'],
        globals: {
          Buffer: true,
          process: true, // this is actually require for some terminal stuff
          // like the shell tool
          global: true,
        },
        protocolImports: true,
        // Exclude Node.js modules that shouldn't be polyfilled in Cloudflare
        exclude: ['child_process', 'fs', 'path'],
      }),
      // Required for WebContainer file write tooling.
      {
        name: 'buffer-polyfill',
        transform(code: string, id: string) {
          if (id.includes('env.mjs')) {
            return {
              code: `import { Buffer } from 'buffer';\n${code}`,
              map: null,
            };
          }
        },
      },
      {
        name: 'ghostbuild-strip-local-dev-vars',
        apply: 'build',
        async closeBundle() {
          await rm(fromRoot('./dist/server/.dev.vars'), { force: true });
        },
      },

      !isTest && cloudflare({ viteEnvironment: { name: 'ssr' } }),
      !isTest &&
        tanstackStart({
          srcDirectory: 'app',
          importProtection: {
            behavior: 'mock',
            mockAccess: 'warn',
          },
          router: {
            routesDirectory: 'routes',
            generatedRouteTree: 'routeTree.gen.ts',
            quoteStyle: 'single',
            semicolons: true,
          },
        }),
      react(),
      isTest && tsconfigPaths(),
      config.mode === 'production' && optimizeCssModules({ apply: 'build' }),
      wasm(),
    ].filter(Boolean),
    envPrefix: ['VITE_'],
  };
});
