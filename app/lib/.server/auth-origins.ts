const PRODUCTION_APP_ORIGIN = 'https://ghostbuild.dev';

export function getAuthTrustedOrigins(baseURL: string | undefined, request?: Request): string[] {
  const requestOrigin = request ? new URL(request.url).origin : undefined;
  return [
    ...new Set([baseURL, requestOrigin, PRODUCTION_APP_ORIGIN].filter((origin): origin is string => Boolean(origin))),
  ];
}
