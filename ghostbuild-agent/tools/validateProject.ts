import type { Tool } from 'ai';
import { z } from 'zod';

export const validateProjectParameters = z.object({
  level: z
    .enum(['fast', 'full'])
    .optional()
    .default('full')
    .describe('fast runs typecheck and lint; full also builds and smoke-checks the live preview when available.'),
});

export const validateProjectTool: Tool = {
  description: `
Run Ghostbuild's fixed, allowlisted project checks in the WebContainer. This is not an arbitrary shell.
The result is tied to the validated workspace revision and reports every check explicitly. Failures return
bounded structured diagnostics; continue unusually large diagnostic sets with getDiagnostics.
Call this after every filesystem or dependency mutation, repair failures, and validate again.
`,
  inputSchema: validateProjectParameters,
};
