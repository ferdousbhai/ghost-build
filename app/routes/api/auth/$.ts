import { createFileRoute } from '@tanstack/react-router';
import { env } from 'cloudflare:workers';

import { getAuth } from '~/lib/.server/auth';

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        return getAuth(env, request).handler(request);
      },
      POST: async ({ request }: { request: Request }) => {
        return getAuth(env, request).handler(request);
      },
    },
  },
});
