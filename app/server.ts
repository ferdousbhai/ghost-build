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
import { refreshDeploymentSecurityInventoryBestEffort } from './lib/.server/cloudflare/deployment-security-inventory';
import { reconcileChatBackupQuotaBestEffort } from './lib/cloudflare/data/chat-backup-quota.server';
import { reconcileThumbnailQuotaBestEffort } from './lib/cloudflare/data/thumbnail-quota.server';
import { cleanupExpiredBuilderPreviewsBestEffort } from './lib/.server/cloudflare/builder-preview-repository';
import { matchPreviewRequest, previewAction } from './server-handlers/previews';

export { BuilderAgent } from './agents/builder-agent';
export { ContainerProxy, DeploymentSandbox } from './lib/.server/cloudflare/deployment-sandbox';
export { DeploymentWorkflow } from './lib/.server/cloudflare/deployment-workflow';
export { SkillSyncWorkflow } from './lib/.server/cloudflare/skill-sync-workflow';

const APPLICATION_CSP_BASELINE = "base-uri 'self'; frame-ancestors 'none'; object-src 'none'; form-action 'self'";
const HSTS_MIN_AGE_SECONDS = '31536000';

function methodNotAllowed(allowedMethod: string) {
  return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: allowedMethod } });
}

function requireMethod(request: Request, method: string, handler: () => Response | Promise<Response>) {
  return request.method === method ? handler() : methodNotAllowed(method);
}

function applyContentSecurityPolicyBaseline(headers: Headers) {
  const current = headers.get('Content-Security-Policy');
  if (!current) {
    headers.set('Content-Security-Policy', APPLICATION_CSP_BASELINE);
  } else if (!current.split(',').some((policy) => policy.trim() === APPLICATION_CSP_BASELINE)) {
    // A CSP list enforces every policy independently. Appending keeps a
    // response's stricter resource policy while making this baseline mandatory.
    headers.append('Content-Security-Policy', APPLICATION_CSP_BASELINE);
  }
}

function applyHstsFloor(headers: Headers) {
  const current = headers.get('Strict-Transport-Security');
  const directives = current?.split(';').map((directive) => directive.trim()) ?? [];
  const maxAgeDirectives = directives.filter((directive) => /^max-age(?:\s*=|$)/i.test(directive));
  const maxAge =
    maxAgeDirectives.length === 1 && maxAgeDirectives[0].length <= 64
      ? /^max-age\s*=\s*(\d{1,20})$/i.exec(maxAgeDirectives[0])?.[1]
      : undefined;
  const normalizedMaxAge = maxAge?.replace(/^0+(?=\d)/, '');
  const meetsFloor =
    normalizedMaxAge !== undefined &&
    (normalizedMaxAge.length > HSTS_MIN_AGE_SECONDS.length ||
      (normalizedMaxAge.length === HSTS_MIN_AGE_SECONDS.length && normalizedMaxAge >= HSTS_MIN_AGE_SECONDS));
  if (current && maxAgeDirectives.length === 1 && meetsFloor) {
    return;
  }
  const retainedDirectives = directives.filter((directive) => directive && !/^max-age(?:\s*=|$)/i.test(directive));
  headers.set('Strict-Transport-Security', [`max-age=${HSTS_MIN_AGE_SECONDS}`, ...retainedDirectives].join('; '));
}

function withApplicationSecurityHeaders(response: Response, pathname: string) {
  const headers = new Headers(response.headers);
  applyContentSecurityPolicyBaseline(headers);
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  applyHstsFloor(headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  if (pathname === '/connect/return') {
    headers.set('Cache-Control', 'no-store');
    headers.set('Pragma', 'no-cache');
  } else if (headers.get('Content-Type')?.toLowerCase().includes('text/html')) {
    // A cached document can reference hashed assets from a deployment that is
    // no longer current. Always revalidate navigations while immutable assets
    // remain cacheable by their content hash.
    headers.set('Cache-Control', 'no-store');
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
    const previewRoute = matchPreviewRequest(pathname);
    if (previewRoute) {
      return previewAction({ request, env, ...previewRoute });
    }
    return withApplicationSecurityHeaders(await routeApplicationRequest(request, env, ctx), pathname);
  },
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduledMaintenance(env));
  },
} satisfies ExportedHandler<Env>;

async function runScheduledMaintenance(env: Env) {
  // Keep connection-heavy D1, R2, and provider maintenance inside the Worker's
  // simultaneous-outgoing-connection budget. Each task is independently
  // bounded and best-effort, so sequencing does not couple their failures.
  await drainDeferredDataGcBestEffort(env);
  await pruneCloudflareAuthDataBestEffort(env.DB);
  await reconcileChatBackupQuotaBestEffort(env);
  await reconcileThumbnailQuotaBestEffort(env);
  await cleanupExpiredBuilderPreviewsBestEffort(env);
  await refreshDeploymentSecurityInventoryBestEffort(env);
}

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
