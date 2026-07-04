import handler from '@tanstack/react-start/server-entry';
import { routeAgentRequest } from 'agents';
import {
  dataAction,
  initialMessagesAction,
  storageObjectAction,
  storeChatAction,
  uploadSnapshotAction,
  uploadThumbnailAction,
} from '~/lib/cloudflare/data.server';
import { getAuth } from './lib/.server/auth';
import { enhancePromptAction } from './server-handlers/enhance-prompt';
import { healthAction } from './server-handlers/health';
import { publicConfigAction } from './server-handlers/public-config';
import { scriptsAction } from './server-handlers/scripts';
import { versionAction } from './server-handlers/version';

export { BuilderAgent } from './agents/builder-agent';

function methodNotAllowed() {
  return Response.json({ error: 'Method not allowed' }, { status: 405 });
}

function requireMethod(request: Request, method: string, handler: () => Response | Promise<Response>) {
  return request.method === method ? handler() : methodNotAllowed();
}

type ServerRoute = {
  method?: string;
  handler: (request: Request, env: Env) => Response | Promise<Response>;
};

const exactRoutes: Record<string, ServerRoute> = {
  '/api/health': {
    handler: () => healthAction(),
  },
  '/api/public-config': {
    method: 'GET',
    handler: (request, env) => publicConfigAction({ request, env }),
  },
  '/api/enhance-prompt': {
    method: 'POST',
    handler: (request, env) => enhancePromptAction({ request, env }),
  },
  '/api/data': {
    method: 'POST',
    handler: (request, env) => dataAction({ request, env }),
  },
  '/api/version': {
    method: 'POST',
    handler: (_request, env) => versionAction({ env }),
  },
  '/store_chat': {
    method: 'POST',
    handler: (request, env) => storeChatAction({ request, env }),
  },
  '/initial_messages': {
    method: 'POST',
    handler: (request, env) => initialMessagesAction({ request, env }),
  },
  '/upload_snapshot': {
    method: 'POST',
    handler: (request, env) => uploadSnapshotAction({ request, env }),
  },
  '/upload_thumbnail': {
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
      const runRoute = () => route.handler(request, env);
      return route.method ? requireMethod(request, route.method, runRoute) : runRoute();
    }

    if (url.pathname.startsWith('/api/storage/')) {
      return storageObjectAction({ key: url.pathname.slice('/api/storage/'.length), env });
    }

    if (url.pathname.startsWith('/scripts/')) {
      return scriptsAction(url.pathname.slice('/scripts/'.length));
    }

    return handler.fetch(request);
  },
} satisfies ExportedHandler<Env>;
