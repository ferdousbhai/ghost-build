import { defineConfig, type PluginOption } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import { productionModuleSecurityPlugin } from "./scripts/lib/runtime-module-security";

const isGhostbuildPreview = process.env.GHOSTBUILD_PREVIEW === "1";
const projectDir = path.dirname(fileURLToPath(import.meta.url));
const baseAlias: Record<string, string> = {
  "@": path.resolve(projectDir, "./src"),
  "#": path.resolve(projectDir, "./src"),
};
const previewAlias: Record<string, string> = isGhostbuildPreview
  ? {
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
    }
  : {};

async function productionPlugins(): Promise<PluginOption[]> {
  if (isGhostbuildPreview) {
    return [];
  }

  const [
    { tanstackStart },
    { cloudflare },
    { default: agents },
    { default: react },
  ] = await Promise.all([
    import("@tanstack/react-start/plugin/vite"),
    import("@cloudflare/vite-plugin"),
    import("agents/vite"),
    import("@vitejs/plugin-react"),
  ]);

  return [
    productionModuleSecurityPlugin(projectDir),
    agents(),
    cloudflare({
      viteEnvironment: { name: "ssr" },
    }),
    tanstackStart(),
    react(),
  ];
}

export default defineConfig(async () => ({
  plugins: [
    ...(await productionPlugins()),
    ...(isGhostbuildPreview ? [tailwindBrowserPreviewPlugin()] : []),
  ],
  resolve: {
    alias: {
      ...baseAlias,
      ...previewAlias,
    },
  },
}));

function tailwindBrowserPreviewPlugin(): PluginOption {
  return {
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
  };
}
