import { getSandbox } from '@cloudflare/sandbox';
import { resolvePreviewAccess } from '~/lib/.server/cloudflare/builder-preview-repository';
import type { DeploymentSandbox } from '~/lib/.server/cloudflare/deployment-sandbox';

const PREVIEW_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PREVIEW_ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PREVIEW_DOCUMENT_CSP = [
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://cdn.tailwindcss.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  'sandbox allow-forms allow-modals allow-popups allow-scripts',
].join('; ');

export function matchPreviewRequest(pathname: string): { previewId: string; accessToken: string; path: string } | null {
  const match = /^\/api\/previews\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(pathname);
  if (!match) {
    return null;
  }
  try {
    const previewId = decodeURIComponent(match[1]);
    const accessToken = decodeURIComponent(match[2]);
    if (!PREVIEW_ID_PATTERN.test(previewId) || !PREVIEW_ACCESS_TOKEN_PATTERN.test(accessToken)) {
      return null;
    }
    return { previewId, accessToken, path: match[3] ?? '' };
  } catch {
    return null;
  }
}

export async function previewAction(args: {
  request: Request;
  env: Env;
  previewId: string;
  accessToken: string;
  path: string;
}): Promise<Response> {
  if (args.request.method !== 'GET' && args.request.method !== 'HEAD') {
    return previewResponse('Preview requests are read-only.', 405, { Allow: 'GET, HEAD' });
  }
  const preview = await resolvePreviewAccess(args.env.DB, args.previewId, args.accessToken);
  if (!preview) {
    return previewResponse('Preview not found or expired.', 404);
  }
  const sandbox = getSandbox(
    args.env.DeploymentSandbox as DurableObjectNamespace<DeploymentSandbox>,
    preview.sandboxId,
    { transport: 'rpc', enableDefaultSession: false, normalizeId: true },
  );
  const sourceUrl = new URL(args.request.url);
  const target = new URL(`http://127.0.0.1:${preview.port}/${args.path}`);
  target.search = sourceUrl.search;
  const headers = new Headers();
  for (const name of ['accept', 'accept-language', 'if-none-match', 'if-modified-since', 'range']) {
    const value = args.request.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }
  const response = await sandbox.containerFetch(
    target.toString(),
    {
      method: args.request.method,
      headers,
      redirect: 'manual',
    },
    preview.port,
  );
  return securePreviewResponse(response, args.previewId, args.accessToken, preview.workspaceRevision);
}

function securePreviewResponse(
  response: Response,
  previewId: string,
  accessToken: string,
  workspaceRevision: number,
): Response {
  const headers = new Headers(response.headers);
  for (const name of [
    'set-cookie',
    'set-cookie2',
    'clear-site-data',
    'cross-origin-opener-policy',
    'cross-origin-embedder-policy',
    'cross-origin-resource-policy',
    'content-security-policy',
    'content-security-policy-report-only',
  ]) {
    headers.delete(name);
  }
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Content-Security-Policy', PREVIEW_DOCUMENT_CSP);
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'SAMEORIGIN');
  headers.set('X-Ghostbuild-Preview-Revision', String(workspaceRevision));
  headers.set('Access-Control-Allow-Origin', 'null');
  const location = headers.get('location');
  if (location) {
    try {
      const resolved = new URL(location, 'http://preview.internal');
      headers.set(
        'location',
        `/api/previews/${encodeURIComponent(previewId)}/${encodeURIComponent(accessToken)}${resolved.pathname}${resolved.search}${resolved.hash}`,
      );
    } catch {
      headers.delete('location');
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function previewResponse(body: string, status: number, additionalHeaders?: HeadersInit): Response {
  return new Response(body, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'self'; sandbox",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      ...additionalHeaders,
    },
  });
}
