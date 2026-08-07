import type { Tool } from 'ghostbuild-agent/pi-tool-compat';
import { z } from 'zod';

const deployToolDescription = `
After validateProject succeeds for the current workspace revision, capture and upload an immutable source snapshot and prepare an exact production
resource plan for explicit user approval. After approval, Ghostbuild's isolated server-side deployment
executor verifies the TanStack + Cloudflare stack, typechecks, builds, and lints before provisioning
anything. It then provisions and deploys using the user's connected Cloudflare account so Cloudflare
bills that user. Do not run production validation commands in the browser; the isolated executor owns
that work so the builder stays responsive.
Production deployment requires a signed-in account and connected Cloudflare account. Guest projects are completed by
validateProject and must not call this tool.
Before this tool returns, describe the action as checking or validating the project. Do not tell
users the project is deployed when the result says the plan is awaiting approval.
If this tool fails, the project is not finished. Use the failure output to fix the project and call
this tool again until the guest project check or production deployment succeeds.

Execute this tool only after validateProject reports success for the latest filesystem and dependency state.

Never request or store Cloudflare production credentials in the generated project. Never claim
Workers Paid was enabled unless the result explicitly confirms the user separately authorized it.
`;

export const deployToolParameters = z.object({
  validatedRevision: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .describe('The exact workspace revision from the latest successful full validateProject result.'),
});

export const deployTool: Tool = {
  description: deployToolDescription,
  inputSchema: deployToolParameters,
};
