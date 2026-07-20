import { defineConfig, type PluginOption } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import path from "path";
import { fileURLToPath } from "url";

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

function cloudflarePlugins(): PluginOption[] {
  if (isGhostbuildPreview) {
    return [];
  }

  return [
    agents(),
    cloudflare({
      viteEnvironment: { name: "ssr" },
    }),
  ];
}

export default defineConfig(() => ({
  plugins: [...cloudflarePlugins(), tanstackStart(), react()],
  resolve: {
    alias: {
      ...baseAlias,
      ...previewAlias,
    },
  },
}));
