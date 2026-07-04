import { z } from 'zod';
import { createScopedLogger } from './logger.js';

const previouslySeen = new WeakSet<object>();
const logger = createScopedLogger('Zod');

export function loggingSafeParse<Output>(schema: z.ZodType<Output>, args: unknown): z.ZodSafeParseResult<Output> {
  const result = schema.safeParse(args);
  if (!result.success) {
    if (typeof args === 'object' && args !== null && !previouslySeen.has(args)) {
      logger.error('Failed to parse zod', args, result.error);
      previouslySeen.add(args);
    }
  }
  return result;
}
