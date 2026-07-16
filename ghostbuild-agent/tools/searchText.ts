import type { Tool } from 'ai';
import { z } from 'zod';

export const searchTextParameters = z.object({
  query: z.string().min(1).max(500).describe('Literal text to find in project files.'),
  path: z.string().max(1_024).optional().describe('Absolute file or directory path under /home/project.'),
  caseSensitive: z.boolean().optional().default(false),
  fileExtensions: z
    .array(z.string().regex(/^\.?[a-zA-Z0-9]+$/))
    .max(12)
    .optional()
    .describe("Optional extensions such as ['ts', 'tsx', 'css']."),
  cursor: z.string().max(64).optional().describe('Exact nextCursor returned by the preceding searchText page.'),
});

export const searchTextTool: Tool = {
  description:
    'Search project text without executing shell commands. Results are stable bounded records with exact totals and a revision-bound nextCursor for additional matches.',
  inputSchema: searchTextParameters,
};
