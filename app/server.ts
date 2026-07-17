import handler from '@tanstack/react-start/server-entry';
import { routeAgentRequest } from 'agents';
import {
  dataAction,
  initialMessagesAction,
  storageObjectAction,
  storeChatAction,
  uploadThumbnailAction,
} from '~/lib/cloudflare/data.server';
import { enhancePromptAction } from './server-handlers/enhance-prompt';
import { healthAction } from './server-handlers/health';
import { scriptsAction } from './server-handlers/scripts';
import { versionAction } from './server-handlers/version';
import { clientTelemetryAction } from './server-handlers/client-telemetry';
import { feedbackAction } from './server-handlers/feedback';
import {
  CLOUDFLARE_CONNECTION_CALLBACK_METHOD,
  cloudflareConnectionStatusAction,
  completeCloudflareConnectionAction,
  startCloudflareConnectionAction,
} from './server-handlers/cloudflare-integration';
import { authorizeAgentRequest } from './lib/.server/agent-request-identity';
import { createDeploymentPlanAction, deploymentAction } from './server-handlers/deployments';
import { authSessionAction, signOutAction } from './server-handlers/auth';

export { BuilderAgent } from './agents/builder-agent';
export { ContainerProxy, DeploymentSandbox } from './lib/.server/cloudflare/deployment-sandbox';
export { DeploymentWorkflow } from './lib/.server/cloudflare/deployment-workflow';

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
  '/api/auth/session': {
    method: 'GET',
    handler: (request, env) => authSessionAction({ request, env }),
  },
  '/api/auth/sign-out': {
    method: 'POST',
    handler: (request, env) => signOutAction({ request, env }),
  },
  '/api/enhance-prompt': {
    method: 'POST',
    handler: (request, env) => enhancePromptAction({ request, env }),
  },
  '/api/client-telemetry': {
    method: 'POST',
    handler: (request) => clientTelemetryAction(request),
  },
  '/api/feedback': {
    method: 'POST',
    handler: (request, env) => feedbackAction({ request, env }),
  },
  '/api/cloudflare/connection': {
    method: 'GET',
    handler: (request, env) => cloudflareConnectionStatusAction({ request, env }),
  },
  '/api/cloudflare/connection/start': {
    method: 'POST',
    handler: (request, env) => startCloudflareConnectionAction({ request, env }),
  },
  '/connect/return': {
    method: CLOUDFLARE_CONNECTION_CALLBACK_METHOD,
    handler: (request, env) => completeCloudflareConnectionAction({ request, env }),
  },
  '/api/deployments/plan': {
    method: 'POST',
    handler: (request, env) => createDeploymentPlanAction({ request, env }),
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
    const url = new URL(request.url);
    let agentProps;
    if (url.pathname.startsWith('/agents/')) {
      const authorization = await authorizeAgentRequest(request, env);
      if ('response' in authorization) {
        return authorization.response;
      }
      agentProps = authorization.identity;
    }
    const agentResponse = await routeAgentRequest(request, env, { props: agentProps });
    if (agentResponse) {
      return agentResponse;
    }

    const route = exactRoutes[url.pathname];
    if (route) {
      return requireMethod(request, route.method, () => route.handler(request, env));
    }

    const deploymentRoute = matchDeploymentRoute(url.pathname);
    if (deploymentRoute) {
      const method = deploymentRoute.operation === 'get' ? 'GET' : 'POST';
      return requireMethod(request, method, () =>
        deploymentAction({
          request,
          env,
          deploymentId: deploymentRoute.deploymentId,
          operation: deploymentRoute.operation,
        }),
      );
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

function matchDeploymentRoute(pathname: string): {
  deploymentId: string;
  operation: 'get' | 'approve' | 'execute' | 'retry';
} | null {
  const match = /^\/api\/deployments\/([^/]+)(?:\/(approve|execute|retry))?$/.exec(pathname);
  if (!match) {
    return null;
  }
  try {
    const operation = match[2] as 'approve' | 'execute' | 'retry' | undefined;
    return {
      deploymentId: decodeURIComponent(match[1]),
      operation: operation ?? 'get',
    };
  } catch {
    return null;
  }
}
