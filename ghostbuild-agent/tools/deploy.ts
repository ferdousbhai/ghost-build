import type { Tool } from 'ai';
import { z } from 'zod';

const deployToolDescription = `
Generate TanStack Start routes, generate Cloudflare binding types, typecheck the app,
verify the TanStack + Cloudflare stack, provision required production Cloudflare resources,
verify production Cloudflare config, build the Cloudflare Worker, run production linting,
apply remote D1 migrations, and deploy directly to the production Cloudflare Worker with Wrangler.

Execute this tool call after you've used an artifact to write files to the filesystem
and the app is complete. Do NOT execute this tool if the app isn't in a working state.

After initially writing the app, you MUST execute this tool after making any changes
to the filesystem.

This tool expects Cloudflare production deployment credentials and bindings to be configured
outside the project. Do not store secrets in local env files or generated source files.
`;

export const deployTool: Tool = {
  description: deployToolDescription,
  inputSchema: z.object({}),
};

export const deployToolParameters = z.object({});
