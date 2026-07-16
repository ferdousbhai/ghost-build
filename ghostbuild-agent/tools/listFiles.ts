import type { Tool } from 'ai';
import { z } from 'zod';

export const listFilesParameters = z.object({
  path: z
    .string()
    .max(1_024)
    .optional()
    .describe('Absolute directory path under /home/project. Defaults to /home/project.'),
  recursive: z.boolean().optional().default(true).describe('Whether to include descendants recursively.'),
  cursor: z.string().max(64).optional().describe('Exact nextCursor returned by the preceding listFiles page.'),
});

export const listFilesTool: Tool = {
  description:
    'List project paths in stable sorted order. Each call returns a bounded complete page with exact totals and a revision-bound nextCursor when more paths remain.',
  inputSchema: listFilesParameters,
};
