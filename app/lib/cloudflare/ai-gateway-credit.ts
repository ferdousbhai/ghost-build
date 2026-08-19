import { z } from 'zod';

export const aiGatewayCreditStatusSchema = z.enum(['available', 'unavailable', 'unknown']);

export type AiGatewayCreditStatus = z.infer<typeof aiGatewayCreditStatusSchema>;
