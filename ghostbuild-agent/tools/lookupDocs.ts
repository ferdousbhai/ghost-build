import type { Tool } from 'ai';
import { z } from 'zod';
import { docDescriptions, docKeys, docs, type DocKey } from '../references/index.js';

const validDocsDescription = docKeys.map((key) => `\`${key}\`: ${docDescriptions[key]}`).join('\n');

export const lookupDocsParameters = z.object({
  docs: z
    .array(z.enum(docKeys))
    .min(1)
    .max(3)
    .describe(
      `List of docs or skill references to look up for the features being implemented.\n${validDocsDescription}`,
    ),
  section: z.string().trim().min(1).max(300).optional().describe('Optional Markdown heading to select exactly.'),
  query: z
    .string()
    .trim()
    .min(2)
    .max(300)
    .optional()
    .describe('Optional text query used to select matching Markdown sections from the requested docs.'),
  cursor: z.string().max(64).optional().describe('Exact nextCursor returned by the preceding lookupDocs page.'),
});

export function lookupDocsTool(): Tool {
  return {
    description: `Lookup bounded documentation sections and skill references for supported stack features. Select a heading or query when possible and reuse nextCursor to continue the same immutable documentation result.\n${validDocsDescription}`,
    inputSchema: lookupDocsParameters,
  };
}

export { docs, type DocKey };
