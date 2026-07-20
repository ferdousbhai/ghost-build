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
  context: z
    .string()
    .max(500)
    .optional()
    .describe('Optional keywords from the current request used only to rank matching files and excerpts.'),
  cursor: z.string().max(64).optional().describe('Exact nextCursor returned by the preceding searchText page.'),
});

export const searchTextTool: Tool = {
  description:
    'Search searchable project text without executing shell commands. Results are relevance-ranked using request context, definitions/imports, and recent edits; each match includes its file revision. Binary, generated, vendor, dependency, and build-output files are excluded. Results are stable bounded records with exact totals and a revision-bound nextCursor for additional matches.',
  inputSchema: searchTextParameters,
};
