import { getCachedPublicRuntimeConfig } from './publicConfig';

export function getCloudflareSiteUrl() {
  const configuredSiteUrl = getCachedPublicRuntimeConfig()?.cloudflareSiteUrl;
  return configuredSiteUrl || (typeof window !== 'undefined' ? window.location.origin : '');
}
