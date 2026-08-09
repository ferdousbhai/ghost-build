import { z } from 'zod';

export const deployToolParameters = z.object({
  validatedRevision: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .describe('The exact workspace revision from the latest successful full validateProject result.'),
});
