const WEBCONTAINER_PREVIEW_HOST_SUFFIX =
  ".local-credentialless.webcontainer-api.io";

export async function finalizeApplicationResponse(
  request: Request,
  agentResponse: Response | null,
  fetchApplication: () => Response | Promise<Response>,
): Promise<Response> {
  if (agentResponse) {
    return agentResponse;
  }
  return withApplicationSecurityHeaders(await fetchApplication(), request);
}

export function withApplicationSecurityHeaders(
  response: Response,
  request: Request,
): Response {
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "credentialless");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  if (!isWebContainerPreviewRequest(request)) {
    headers.set("X-Frame-Options", "DENY");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isWebContainerPreviewRequest(request: Request): boolean {
  const { hostname, protocol } = new URL(request.url);
  return (
    protocol === "https:" &&
    hostname.endsWith(WEBCONTAINER_PREVIEW_HOST_SUFFIX) &&
    hostname.length > WEBCONTAINER_PREVIEW_HOST_SUFFIX.length
  );
}
