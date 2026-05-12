import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'

const testAlias = process.env.VITEST
  ? {
      'cloudflare:workers': fileURLToPath(
        new URL('./src/test/cloudflare-workers.ts', import.meta.url),
      ),
    }
  : undefined

const config = defineConfig(() => ({
  resolve: {
    tsconfigPaths: true,
    alias: testAlias,
  },
  plugins: [
    devtools(),
    !process.env.VITEST && cloudflare({ viteEnvironment: { name: 'ssr' } }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
}))

export default config
