import type { Tool } from 'ai';
import { z } from 'zod';

const editToolDescription = `
Replace a string of text that appears exactly once in a file with a
new string of text. Use this tool when fixing a bug, making a
targeted change, or replacing a file whose current contents are known.

You MUST know a file's current contents before using this tool. This may
either be from context or previous use of the \`view\` tool.

Prefer the smallest stable \`old\` fragment that appears exactly once.
`;

export const editToolParameters = z.object({
  path: z.string().describe('The absolute path to the file to edit.'),
  old: z.string().describe('The fragment of text to replace. It must appear exactly once in the file.'),
  new: z.string().describe('The new fragment of text to replace it with.'),
});

export const editTool: Tool = {
  description: editToolDescription,
  inputSchema: editToolParameters,
};
