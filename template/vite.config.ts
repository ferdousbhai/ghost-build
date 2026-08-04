import { defineConfig, type PluginOption } from "vite";
import path from "path";
import { fileURLToPath } from "url";

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const baseAlias: Record<string, string> = {
  "@": path.resolve(projectDir, "./src"),
  "#": path.resolve(projectDir, "./src"),
};
async function productionPlugins(
  isolatedPreview: boolean,
): Promise<PluginOption[]> {
  const [
    { tanstackStart },
    { cloudflare },
    { default: agents },
    { default: react },
    { productionModuleSecurityPlugin },
  ] = await Promise.all([
    import("@tanstack/react-start/plugin/vite"),
    import("@cloudflare/vite-plugin"),
    import("agents/vite"),
    import("@vitejs/plugin-react"),
    import("./scripts/lib/runtime-module-security.ts"),
  ]);

  return [
    productionModuleSecurityPlugin(projectDir),
    agents(),
    cloudflare({
      viteEnvironment: { name: "ssr" },
      ...(isolatedPreview
        ? { configPath: "./wrangler.preview.jsonc", remoteBindings: false }
        : {}),
    }),
    tanstackStart(),
    react(),
  ];
}

export default defineConfig(async ({ mode }) => ({
  plugins: await productionPlugins(mode === "ghostbuild-isolated-preview"),
  resolve: {
    alias: baseAlias,
  },
}));
