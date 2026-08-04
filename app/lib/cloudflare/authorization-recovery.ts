export const CLOUDFLARE_AUTHORIZATION_ERROR_PARAM = 'cloudflare_authorization';
export const CLOUDFLARE_AUTHORIZATION_ERROR_VALUE = 'failed';

export const CLOUDFLARE_AUTHORIZATION_ERROR_MESSAGE = "Cloudflare couldn't authorize this connection. Try again.";

export function hasCloudflareAuthorizationError(search: URLSearchParams): boolean {
  return search.get(CLOUDFLARE_AUTHORIZATION_ERROR_PARAM) === CLOUDFLARE_AUTHORIZATION_ERROR_VALUE;
}
