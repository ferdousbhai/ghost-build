import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { docKeys, docDescriptions } from '../references/index.js';

// Unified Pi tool schemas — mirrors cloudflare-os defineTool pattern (agent.ts: defineTool)
// Keep Zod exports for backward compat during strangler; Pi tools are authoritative.

function defineTool<T extends ReturnType<typeof Type.Object>>(def: AgentTool<T>): AgentTool {
  return def as unknown as AgentTool;
}

const validDocsDescription = docKeys.map((key) => `\`${key}\`: ${docDescriptions[key]}`).join('\n');

export const deployPiTool = defineTool({
  name: 'deploy',
  label: 'Deploy project',
  description: `
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
`.trim(),
  parameters: Type.Object({
    validatedRevision: Type.String({
      pattern: '^[a-f0-9]{64}$',
      description: 'The exact workspace revision from the latest successful full validateProject result.',
    }),
  }),
  execute: async () => {
    throw new Error('deploy tool execute is wired in pi-agent.ts via BuilderWorkspaceApi');
  },
});

export const lookupDocsPiTool = defineTool({
  name: 'lookupDocs',
  label: 'Look up documentation',
  description:
    `Lookup bounded documentation sections and skill references for supported stack features. Select a heading or query when possible and reuse nextCursor to continue the same immutable documentation result.\n${validDocsDescription}`.trim(),
  parameters: Type.Object({
    docs: Type.Array(Type.Union(docKeys.map((k) => Type.Literal(k)) as never[]), {
      description: `List of docs or skill references to look up.\n${validDocsDescription}`,
      minItems: 1,
      maxItems: 3,
    }),
    section: Type.Optional(
      Type.String({ description: 'Optional Markdown heading to select exactly.', minLength: 1, maxLength: 300 }),
    ),
    query: Type.Optional(
      Type.String({
        description: 'Optional text query used to select matching sections.',
        minLength: 2,
        maxLength: 300,
      }),
    ),
    cursor: Type.Optional(
      Type.String({ description: 'Exact nextCursor from preceding lookupDocs page.', maxLength: 64 }),
    ),
  }),
  execute: async () => {
    throw new Error('lookupDocs tool execute is wired in pi-agent.ts');
  },
});

export const npmInstallPiTool = defineTool({
  name: 'npmInstall',
  label: 'Install dependencies',
  description: 'Install npm dependencies for the generated project. Use spec array for registry selectors.',
  parameters: Type.Object({
    specs: Type.Optional(Type.Array(Type.String({ description: 'npm registry selectors' }))),
  }),
  execute: async () => {
    throw new Error('npmInstall tool execute is wired in pi-agent.ts');
  },
});

export const validateProjectPiTool = defineTool({
  name: 'validateProject',
  label: 'Validate project',
  description: 'Run full project validation (typecheck, build, lint) against the current workspace revision.',
  parameters: Type.Object({}),
  execute: async () => {
    throw new Error('validateProject tool execute is wired in pi-agent.ts');
  },
});

export const piToolStubs = {
  deploy: deployPiTool,
  lookupDocs: lookupDocsPiTool,
  npmInstall: npmInstallPiTool,
  validateProject: validateProjectPiTool,
} as const;
