import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.dirname(fileURLToPath(import.meta.url));

export default {
  plugins: [
    {
      name: "ghostbuild-preview-tailwind",
      transformIndexHtml: {
        order: "pre",
        handler() {
          return [
            {
              tag: "script",
              attrs: {
                src: "https://cdn.tailwindcss.com/3.4.17",
              },
              injectTo: "head",
            },
          ];
        },
      },
    },
  ],
  esbuild: {
    tsconfigRaw: JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        useDefineForClassFields: true,
        jsx: "react-jsx",
        module: "ESNext",
        moduleResolution: "Bundler",
        allowImportingTsExtensions: true,
      },
    }),
  },
  css: { postcss: { plugins: [] } },
  resolve: {
    alias: {
      "@": path.resolve(projectDir, "./src"),
      "#": path.resolve(projectDir, "./src"),
      "@cloudflare/ai-chat/react": path.resolve(
        projectDir,
        "./src/preview/ai-chat-react.ts",
      ),
      "@cloudflare/ai-chat": path.resolve(
        projectDir,
        "./src/preview/ai-chat.ts",
      ),
      "agents/react": path.resolve(projectDir, "./src/preview/agents-react.ts"),
      agents: path.resolve(projectDir, "./src/preview/agents.ts"),
      "workers-ai-provider": path.resolve(
        projectDir,
        "./src/preview/workers-ai-provider.ts",
      ),
      "@tanstack/react-router": path.resolve(
        projectDir,
        "./src/preview/tanstack-react-router.tsx",
      ),
    },
  },
};
