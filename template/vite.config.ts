import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
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
    }
  : {};

async function productionPlugins(): Promise<PluginOption[]> {
  if (isGhostbuildPreview) {
    return [];
  }

  const [{ tanstackStart }, { cloudflare }, { default: agents }] =
    await Promise.all([
      import("@tanstack/react-start/plugin/vite"),
      import("@cloudflare/vite-plugin"),
      import("agents/vite"),
    ]);

  return [
    productionModuleSecurityPlugin(projectDir),
    agents(),
    cloudflare({
      viteEnvironment: { name: "ssr" },
    }),
    tanstackStart(),
  ];
}

export default defineConfig(async () => ({
  plugins: [...(await productionPlugins()), react()],
  resolve: {
    alias: {
      ...baseAlias,
      ...previewAlias,
    },
  },
}));
