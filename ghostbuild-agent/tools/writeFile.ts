import type { Tool } from 'ai';
import { z } from 'zod';

const writeFileDescription = `
Write the full contents of a file. Use this tool for new files, whole-file rewrites,
or large changes where replacing a small exact fragment would be brittle.
When you say you will write or update a file, call this tool immediately instead
of ending the response with a plan.

You MUST provide the complete final file contents. Do not use placeholders or omit
unchanged sections.
`;

export const writeFileParameters = z.object({
  path: z.string().describe('The absolute path to the file to write.'),
  content: z.string().describe('The complete file contents to write.'),
});

export const writeFileTool: Tool = {
  description: writeFileDescription,
  inputSchema: writeFileParameters,
};
