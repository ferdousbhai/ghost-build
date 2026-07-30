import type { Tool } from 'ai';
import { z } from 'zod';

const viewRangeDescription = `
An optional pair specifying the inclusive start and exclusive end line numbers to view.
Line numbers are 1-indexed and a request may cover at most 200 lines. The result reports the
file's exact total line count and exact coverage of the requested range.
`;

const viewDescription = `
Read a bounded, explicit line range from one file. Use listFiles for directories and searchText for
content discovery. Be sure to use this tool when editing a file whose current contents are not known.

The result includes exact line and character coverage. Unusually dense requested ranges continue by
calling view again with the same path, range, and returned revision-bound nextCursor.
`;

const viewRangeParameters = z
  .array(z.number().int().min(1))
  .length(2)
  .superRefine(([start, end], ctx) => {
    if (end <= start) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'view_range end must be greater than start.' });
    }
    if (end - start > 200) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'view_range may contain at most 200 lines.' });
    }
  });

export const viewParameters = z.object({
  path: z.string().max(1_024).describe('The absolute path to the file to read.'),
  view_range: viewRangeParameters.optional().default([1, 201]).describe(viewRangeDescription),
  cursor: z.string().max(64).optional().describe('Exact nextCursor returned when a dense range spans pages.'),
});

export const viewToolInputParameters = z.object({
  path: z.string().max(1_024),
  view_range: viewRangeParameters.optional(),
  cursor: z.string().max(64).optional(),
});

export const viewTool: Tool = {
  description: viewDescription,
  inputSchema: viewParameters,
};
