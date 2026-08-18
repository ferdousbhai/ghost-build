import { z, type ZodType } from 'zod';
import { lineEditToolParameters } from './line-edit.js';

const pathSchema = z.object({ path: z.string() });

/** Tools executed against the durable project workspace, under its operation lane. */
export const WORKSPACE_TOOL_NAMES = ['read', 'write', 'edit', 'exec'] as const;
export type WorkspaceToolName = (typeof WORKSPACE_TOOL_NAMES)[number];

export const MODEL_TOOL_NAMES = [...WORKSPACE_TOOL_NAMES, 'search_cloudflare_docs'] as const;
export type ModelToolName = (typeof MODEL_TOOL_NAMES)[number];

/** Complete model-facing contracts for every tool the model may call. */
export const MODEL_TOOL_INPUT_SCHEMAS = {
  read: pathSchema.extend({
    offset: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).optional(),
  }),
  write: pathSchema.extend({ content: z.string() }),
  edit: lineEditToolParameters,
  exec: z.object({
    command: z.string(),
    cwd: z.string().optional(),
  }),
  search_cloudflare_docs: z.object({ query: z.string() }),
} as const satisfies Record<ModelToolName, ZodType>;
