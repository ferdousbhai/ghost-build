import type { Tool } from 'ai';
import { z } from 'zod';
import { docDescriptions, docKeys, docs, type DocKey } from '../references/index.js';

const validDocsDescription = docKeys.map((key) => `\`${key}\`: ${docDescriptions[key]}`).join('\n');

export const lookupDocsParameters = z.object({
  docs: z
    .array(z.enum(docKeys))
    .describe(
      `List of docs or skill references to look up for the features being implemented.\n${validDocsDescription}`,
    ),
});

export function lookupDocsTool(): Tool {
  return {
    description: `Lookup documentation snippets and skill references for supported stack features.\n${validDocsDescription}`,
    inputSchema: lookupDocsParameters,
  };
}

export { docs, type DocKey };
