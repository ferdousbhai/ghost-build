import type { Tool } from 'ghostbuild-agent/pi-tool-compat';
import { z } from 'zod';

export const validateProjectParameters = z.object({});

export const validateProjectTool: Tool = {
  description: `
Run Ghostbuild's fixed, allowlisted project checks in the isolated server build sandbox. This is not an arbitrary shell.
The result is tied to the validated workspace revision and reports every check explicitly. Failures return
bounded diagnostics.
Call this after every filesystem or dependency mutation, repair failures, and validate again.
`,
  inputSchema: validateProjectParameters,
};
