import type { Tool } from 'ai';
import { z } from 'zod';

const deployToolDescription = `
Generate TanStack Start routes, generate Cloudflare binding types, typecheck the app,
verify the TanStack + Cloudflare stack, build the Cloudflare Worker, and run production linting.
For signed-in users, upload an immutable source snapshot and prepare an exact production resource
plan for explicit user approval. Ghostbuild's server-side deployment executor provisions and deploys
only after approval, using the user's connected Cloudflare account so Cloudflare bills that user.
In guest Ghostbuild preview sessions, this checks that generated source replaced the starter
app without running Cloudflare production deployment. The workbench preview server handles live
preview separately. Production deployment requires a signed-in account and connected Cloudflare account.
Before this tool returns, describe the action as checking or validating the app. Do not tell
users the app is deployed when the result says the plan is awaiting approval.
If this tool fails, the app is not finished. Use the failure output to fix the app and call
this tool again until the guest app check or production deployment succeeds.

Execute this tool call after you've used writeFile or edit to write files to the filesystem
and the app is complete. Do NOT execute this tool if the app isn't in a working state.

After initially writing the app, you MUST execute this tool after making any changes
to the filesystem.

Never request or store Cloudflare production credentials in the generated project. Never claim
Workers Paid was enabled unless the result explicitly confirms the user separately authorized it.
`;

export const deployToolParameters = z.object({});

export const deployTool: Tool = {
  description: deployToolDescription,
  inputSchema: deployToolParameters,
};
