import type { Tool } from 'ai';
import { z } from 'zod';

export const getDiagnosticsParameters = z.object({
  diagnosticsId: z.string().uuid().describe('Diagnostics id returned by validateProject or npmInstall.'),
  cursor: z.string().max(32).optional().describe('Exact nextCursor returned by the preceding diagnostics page.'),
});

export const getDiagnosticsTool: Tool = {
  description:
    'Read the next bounded page of structured diagnostics from a completed validation or dependency operation. Reuse the exact nextCursor from the preceding page.',
  inputSchema: getDiagnosticsParameters,
};
