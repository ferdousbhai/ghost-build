import { createSocialPageHead } from './social-meta';

const GHOSTBUILD_REPOSITORY_URL = 'https://github.com/ferdousbhai/ghost-build';
export const GHOSTBUILD_OPERATOR_URL = 'https://github.com/ferdousbhai';
export const GHOSTBUILD_SUPPORT_URL = `${GHOSTBUILD_REPOSITORY_URL}/issues/new?template=support_request.yml`;
export const GHOSTBUILD_ABUSE_URL = `${GHOSTBUILD_REPOSITORY_URL}/issues/new?template=abuse_report.yml`;
export const GHOSTBUILD_SECURITY_URL = `${GHOSTBUILD_REPOSITORY_URL}/security/advisories/new`;
export const CLOUDFLARE_ABUSE_URL = 'https://abuse.cloudflare.com/';

export const TRUST_DOCUMENT_VERSION = '1.2 public beta';
export const TRUST_DOCUMENT_EFFECTIVE_ISO_DATE = '2026-08-04';
export const TRUST_DOCUMENT_EFFECTIVE_DATE = 'August 4, 2026';
export const TRUST_DOCUMENT_STATUS =
  'These pages describe the current service, its public-beta limitations, and the channels that are actually available.';
export const TRUST_CHANNEL_STATUS =
  'Ghostbuild aims to review and acknowledge reports submitted through its published support and abuse forms within two weekdays and private security reports within one weekday. These public-beta targets are not guarantees or contractual service levels. Channels are not monitored continuously, and Ghostbuild does not provide 24/7 or real-time emergency response.';

export const TRUST_LINKS = [
  { href: '/privacy', label: 'Privacy' },
  { href: '/terms', label: 'Terms' },
  { href: '/support', label: 'Support' },
  { href: '/abuse', label: 'Report abuse' },
  { href: '/security', label: 'Security' },
] as const;

export function createPublicBetaTrustPageHead(options: { title: string; description: string; path: string }) {
  return createSocialPageHead({
    ...options,
    imagePath: '/social-preview-home-v2.png',
    imageAlt: 'Ghostbuild — build and ship Cloudflare apps',
  });
}
