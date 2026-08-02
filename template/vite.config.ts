import { defineConfig, type PluginOption } from "vite";
import path from "path";
import { fileURLToPath } from "url";

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const baseAlias: Record<string, string> = {
  "@": path.resolve(projectDir, "./src"),
  "#": path.resolve(projectDir, "./src"),
};

async function productionPlugins(): Promise<PluginOption[]> {
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
    }),
    tanstackStart(),
    react(),
  ];
}

export default defineConfig(async () => ({
  plugins: await productionPlugins(),
  resolve: {
    alias: baseAlias,
  },
}));
