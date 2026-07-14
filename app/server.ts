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
import { feedbackAction } from './server-handlers/feedback';
import {
  cloudflareConnectionStatusAction,
  completeCloudflareConnectionAction,
  startCloudflareConnectionAction,
} from './server-handlers/cloudflare-integration';
import { authorizeAgentRequest } from './lib/.server/agent-request-identity';
import { aiAllowanceStatusAction } from './server-handlers/ai-allowance';
import { createDeploymentPlanAction, deploymentAction } from './server-handlers/deployments';

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
  '/api/cloudflare/connection/callback': {
    method: 'GET',
    handler: (request, env) => completeCloudflareConnectionAction({ request, env }),
  },
  '/connect/return': {
    method: 'POST',
    handler: (request, env) => completeCloudflareConnectionAction({ request, env }),
  },
  '/api/ai/allowance': {
    method: 'GET',
    handler: (request, env) => aiAllowanceStatusAction({ request, env }),
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

    if (url.pathname === '/api/auth' || url.pathname.startsWith('/api/auth/')) {
      return getAuth(env, request).handler(request);
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
  operation: 'get' | 'approve' | 'execute';
} | null {
  const match = /^\/api\/deployments\/([^/]+)(?:\/(approve|execute))?$/.exec(pathname);
  if (!match) {
    return null;
  }
  try {
    return {
      deploymentId: decodeURIComponent(match[1]),
      operation: match[2] === 'approve' ? 'approve' : match[2] === 'execute' ? 'execute' : 'get',
    };
  } catch {
    return null;
  }
}
