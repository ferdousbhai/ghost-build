import { createSocialPageHead } from './social-meta';

const GHOSTBUILD_REPOSITORY_URL = 'https://github.com/ferdousbhai/ghost-build';
export const GHOSTBUILD_SUPPORT_URL = `${GHOSTBUILD_REPOSITORY_URL}/issues/new?template=support_request.yml`;
export const GHOSTBUILD_ABUSE_URL = `${GHOSTBUILD_REPOSITORY_URL}/issues/new?template=abuse_report.yml`;
export const GHOSTBUILD_SECURITY_URL = `${GHOSTBUILD_REPOSITORY_URL}/security/advisories/new`;

export const TRUST_DOCUMENT_VERSION = '1.0 launch candidate';
export const TRUST_DOCUMENT_PROPOSED_EFFECTIVE_ISO_DATE = '2026-08-04';
export const TRUST_DOCUMENT_PROPOSED_EFFECTIVE_DATE = 'August 4, 2026';
export const TRUST_DOCUMENT_REVIEW_STATUS =
  'Awaiting Ghostbuild owner approval and review by qualified counsel. This launch candidate is not approved for production publication.';
export const TRUST_CHANNEL_STATUS =
  'GitHub private vulnerability reporting is enabled as of August 4, 2026. Notification delivery and monitored-channel escalation ownership have not been confirmed by the owner.';

export const TRUST_LINKS = [
  { href: '/privacy', label: 'Privacy' },
  { href: '/terms', label: 'Terms' },
  { href: '/support', label: 'Support' },
  { href: '/abuse', label: 'Report abuse' },
  { href: '/security', label: 'Security' },
] as const;

export function createLaunchCandidateTrustPageHead(options: { title: string; description: string; path: string }) {
  const head = createSocialPageHead({
    ...options,
    imagePath: '/social-preview-home-v2.png',
    imageAlt: 'Ghostbuild — build and ship Cloudflare apps',
  });
  return { ...head, meta: [...head.meta, { name: 'robots', content: 'noindex, nofollow' }] };
}
