import handler from '@tanstack/react-start/server-entry';
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
import { routeAuthorizedAgentRequest } from './lib/.server/agent-request-identity';
import { createDeploymentPlanAction, deploymentAction } from './server-handlers/deployments';
import { authSessionAction, signOutAction } from './server-handlers/auth';
import { drainDeferredDataGcBestEffort } from './lib/cloudflare/data/deferred-gc.server';
import { pruneCloudflareAuthDataBestEffort } from './lib/cloudflare/data/cloudflare-auth-retention.server';

export { BuilderAgent } from './agents/builder-agent';
export { ContainerProxy, DeploymentSandbox } from './lib/.server/cloudflare/deployment-sandbox';
export { DeploymentWorkflow } from './lib/.server/cloudflare/deployment-workflow';

function methodNotAllowed(allowedMethod: string) {
  return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: allowedMethod } });
}

function requireMethod(request: Request, method: string, handler: () => Response | Promise<Response>) {
  return request.method === method ? handler() : methodNotAllowed(method);
}

function withApplicationSecurityHeaders(response: Response, pathname: string) {
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  if (pathname === '/connect/return') {
    headers.set('Cache-Control', 'no-store');
    headers.set('Pragma', 'no-cache');
  } else if (pathname.startsWith('/api/') && !headers.has('Cache-Control')) {
    headers.set('Cache-Control', 'no-store');
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

type ServerRoute = {
  method: 'GET' | 'POST';
  handler: (request: Request, env: Env, ctx?: ExecutionContext) => Response | Promise<Response>;
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
    handler: (request, env) => clientTelemetryAction({ request, env }),
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
    handler: (request, env, executionCtx) => dataAction({ request, env, executionCtx }),
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
  async fetch(request: Request, env: Env, ctx?: ExecutionContext) {
    const agentResponse = await routeAuthorizedAgentRequest(request, env);
    if (agentResponse) {
      return agentResponse;
    }

    const pathname = new URL(request.url).pathname;
    return withApplicationSecurityHeaders(await routeApplicationRequest(request, env, ctx), pathname);
  },
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(Promise.all([drainDeferredDataGcBestEffort(env), pruneCloudflareAuthDataBestEffort(env.DB)]));
  },
} satisfies ExportedHandler<Env>;

async function routeApplicationRequest(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  const route = exactRoutes[url.pathname];
  if (route) {
    return requireMethod(request, route.method, () => route.handler(request, env, ctx));
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
    return requireMethod(request, 'GET', () =>
      storageObjectAction({ request, key: url.pathname.slice('/api/storage/'.length), env }),
    );
  }

  if (url.pathname.startsWith('/scripts/')) {
    return requireMethod(request, 'GET', () => scriptsAction(url.pathname.slice('/scripts/'.length)));
  }

  return handler.fetch(request);
}

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
