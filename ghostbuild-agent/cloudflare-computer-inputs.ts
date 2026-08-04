import { z, type ZodType } from 'zod';
import { COMPUTER_SHELL_BACKEND_IDS, type ComputerToolName } from './cloudflare-computer.js';

const pathSchema = z.object({ path: z.string() });

export const COMPUTER_TOOL_INPUT_SCHEMAS = {
  read: pathSchema.extend({
    offset: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).optional(),
  }),
  ls: pathSchema,
  write: pathSchema.extend({ content: z.string() }),
  edit: pathSchema.extend({
    edits: z.array(z.object({ oldText: z.string(), newText: z.string() }).strict()),
  }),
  exec: z.object({
    command: z.string(),
    cwd: z.string().optional(),
    backend: z.enum(COMPUTER_SHELL_BACKEND_IDS).optional(),
  }),
} as const satisfies Record<ComputerToolName, ZodType>;
