import { z, type ZodType } from 'zod';
import { COMPUTER_SHELL_BACKEND_IDS, type ComputerToolName } from './cloudflare-computer.js';
import { lineEditToolParameters } from './line-edit.js';

const pathSchema = z.object({ path: z.string() });

/** Complete model-facing contracts for the four primitives plus Computer's internal ls capability. */
export const MODEL_TOOL_INPUT_SCHEMAS = {
  read: pathSchema.extend({
    offset: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).optional(),
  }),
  ls: pathSchema,
  write: pathSchema.extend({ content: z.string() }),
  edit: lineEditToolParameters,
  exec: z.object({
    command: z.string(),
    cwd: z.string().optional(),
    backend: z
      .enum(COMPUTER_SHELL_BACKEND_IDS)
      .optional()
      .describe('Omit to use container-shell, the only available execution backend.'),
  }),
} as const satisfies Record<ComputerToolName, ZodType>;
