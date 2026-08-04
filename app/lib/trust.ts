import { createSocialPageHead } from './social-meta';

const GHOSTBUILD_REPOSITORY_URL = 'https://github.com/ferdousbhai/ghost-build';
export const GHOSTBUILD_SUPPORT_URL = `${GHOSTBUILD_REPOSITORY_URL}/issues/new?template=support_request.yml`;
export const GHOSTBUILD_ABUSE_URL = `${GHOSTBUILD_REPOSITORY_URL}/issues/new?template=abuse_report.yml`;
export const GHOSTBUILD_SECURITY_URL = `${GHOSTBUILD_REPOSITORY_URL}/security/advisories/new`;

export const TRUST_DOCUMENT_VERSION = '1.0 public beta';
export const TRUST_DOCUMENT_EFFECTIVE_ISO_DATE = '2026-08-04';
export const TRUST_DOCUMENT_EFFECTIVE_DATE = 'August 4, 2026';
export const TRUST_DOCUMENT_STATUS =
  'These pages describe the current public beta. They are maintained by the project owner and have not been reviewed by qualified counsel.';
export const TRUST_CHANNEL_STATUS =
  'Support and abuse use public GitHub issues for non-sensitive reports. Security vulnerabilities use GitHub private vulnerability reporting. No response-time commitment is offered during public beta.';

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
