import handler from '@tanstack/react-start/server-entry';
import { routeAgentRequest } from 'agents';
import {
  dataAction,
  initialMessagesAction,
  storageObjectAction,
  storeChatAction,
  uploadThumbnailAction,
} from '~/lib/cloudflare/data.server';
import { getAuth } from './lib/.server/auth';
import { enhancePromptAction } from './server-handlers/enhance-prompt';
import { healthAction } from './server-handlers/health';
import { scriptsAction } from './server-handlers/scripts';
import { versionAction } from './server-handlers/version';
import { clientTelemetryAction } from './server-handlers/client-telemetry';

export { BuilderAgent } from './agents/builder-agent';

function methodNotAllowed(allowedMethod: string) {
  return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: allowedMethod } });
}

function requireMethod(request: Request, method: string, handler: () => Response | Promise<Response>) {
  return request.method === method ? handler() : methodNotAllowed(method);
}

function withCrossOriginIsolationHeaders(response: Response) {
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'credentialless');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

type ServerRoute = {
  method: 'GET' | 'POST';
  handler: (request: Request, env: Env) => Response | Promise<Response>;
};

const exactRoutes: Record<string, ServerRoute> = {
  '/api/health': {
    method: 'GET',
    handler: () => healthAction(),
  },
  '/api/enhance-prompt': {
    method: 'POST',
    handler: (request, env) => enhancePromptAction({ request, env }),
  },
  '/api/client-telemetry': {
    method: 'POST',
    handler: (request) => clientTelemetryAction(request),
  },
  '/api/data': {
    method: 'POST',
    handler: (request, env) => dataAction({ request, env }),
  },
  '/api/version': {
    method: 'GET',
    handler: (_request, env) => versionAction({ env }),
  },
  '/api/chats/store': {
    method: 'POST',
    handler: (request, env) => storeChatAction({ request, env }),
  },
  '/api/chats/messages': {
    method: 'POST',
    handler: (request, env) => initialMessagesAction({ request, env }),
  },
  '/api/thumbnails': {
    method: 'POST',
    handler: (request, env) => uploadThumbnailAction({ request, env }),
  },
};

export default {
  async fetch(request: Request, env: Env) {
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) {
      return agentResponse;
    }

    const url = new URL(request.url);
    if (url.pathname === '/api/auth' || url.pathname.startsWith('/api/auth/')) {
      return getAuth(env, request).handler(request);
    }

    const route = exactRoutes[url.pathname];
    if (route) {
      return requireMethod(request, route.method, () => route.handler(request, env));
    }

    if (url.pathname.startsWith('/api/storage/')) {
      return storageObjectAction({ key: url.pathname.slice('/api/storage/'.length), env });
    }

    if (url.pathname.startsWith('/scripts/')) {
      return scriptsAction(url.pathname.slice('/scripts/'.length));
    }

    const appResponse = await handler.fetch(request);
    return withCrossOriginIsolationHeaders(appResponse);
  },
} satisfies ExportedHandler<Env>;
