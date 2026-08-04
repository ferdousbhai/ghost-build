import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(projectDir, "./src");
const virtualLucideId = "\0ghostbuild:lucide-react";

export default {
  plugins: [
    {
      name: "ghostbuild-preview-lucide",
      resolveId(source) {
        return source === "lucide-react" ? virtualLucideId : undefined;
      },
      async load(id) {
        if (id !== virtualLucideId) {
          return undefined;
        }
        const iconNames = await findImportedLucideIcons(sourceDir);
        return [
          'import { createPreviewIcon } from "/src/preview/lucide-react.tsx";',
          ...iconNames.map(
            (name) =>
              `export const ${name} = createPreviewIcon(${JSON.stringify(name)});`,
          ),
        ].join("\n");
      },
      handleHotUpdate({ file, server }) {
        if (!file.startsWith(`${sourceDir}${path.sep}`)) {
          return;
        }
        const lucideModule = server.moduleGraph.getModuleById(virtualLucideId);
        if (lucideModule) {
          server.moduleGraph.invalidateModule(lucideModule);
        }
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

async function findImportedLucideIcons(directory) {
  const iconNames = new Set();
  for (const file of await sourceFiles(directory)) {
    const source = await fs.readFile(file, "utf8");
    const importPattern = /import\s*\{([^}]*)\}\s*from\s*["']lucide-react["']/g;
    for (const match of source.matchAll(importPattern)) {
      for (const binding of match[1].split(",")) {
        const importedName = binding
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0];
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(importedName)) {
          iconNames.add(importedName);
        }
      }
    }
  }
  return [...iconNames].sort();
}

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(file)));
    } else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
      files.push(file);
    }
  }
  return files;
}
