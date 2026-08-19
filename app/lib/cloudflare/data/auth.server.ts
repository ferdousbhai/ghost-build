import { z } from 'zod';

export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized');
  }
}

const sessionScopedArgsSchema = z.looseObject({ sessionId: z.string() });

export function getSessionId(args: unknown): string | null {
  const parsed = sessionScopedArgsSchema.safeParse(args);
  return parsed.success ? parsed.data.sessionId : null;
}
