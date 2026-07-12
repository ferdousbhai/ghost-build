import type { Tool } from 'ai';
import { z } from 'zod';

const deployToolDescription = `
Generate TanStack Start routes, generate Cloudflare binding types, typecheck the app,
verify the TanStack + Cloudflare stack, provision required production Cloudflare resources,
verify production Cloudflare config, build the Cloudflare Worker, run production linting,
apply remote D1 migrations, and deploy directly to the production Cloudflare Worker with Wrangler.
In guest Ghostbuild preview sessions, this checks that generated source replaced the starter
app without running Cloudflare production deployment. The workbench preview server handles live
preview separately. Production deployment requires a signed-in account with deployment access.
Before this tool returns, describe the action as checking or validating the app. Do not tell
guest users the app is deployed unless this tool result confirms a production deployment.
If this tool fails, the app is not finished. Use the failure output to fix the app and call
this tool again until the guest app check or production deployment succeeds.

Execute this tool call after you've used writeFile or edit to write files to the filesystem
and the app is complete. Do NOT execute this tool if the app isn't in a working state.

After initially writing the app, you MUST execute this tool after making any changes
to the filesystem.

This tool expects Cloudflare production deployment credentials and bindings to be configured
outside the project. Do not store secrets in local env files or generated source files.
`;

export const deployToolParameters = z.object({});

export const deployTool: Tool = {
  description: deployToolDescription,
  inputSchema: deployToolParameters,
};
