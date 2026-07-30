import type { Tool } from 'ai';
import { z } from 'zod';

const editToolDescription = `
Apply one or more non-overlapping exact replacements to a single file. Every old fragment is matched
against the same original file and must appear exactly once. Use this tool for targeted changes.

You MUST know a file's current contents before using this tool. This may
either be from context or previous use of the \`view\` tool.

Prefer the smallest stable old fragment that appears exactly once. Merge replacements that overlap
or touch the same logical block.
`;

export const editReplacementParameters = z.object({
  old: z.string().min(1).describe('An exact fragment that appears once in the original file.'),
  new: z.string().describe('The replacement for this fragment.'),
});

export const editToolParameters = z.object({
  path: z.string().max(1_024).describe('The absolute path to the file to edit.'),
  edits: z.array(editReplacementParameters).min(1).max(20).describe('Non-overlapping replacements.'),
});

export const editTool: Tool = {
  description: editToolDescription,
  inputSchema: editToolParameters,
};
