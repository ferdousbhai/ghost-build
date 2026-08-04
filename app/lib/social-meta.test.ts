import { describe, expect, it } from 'vitest';
import { createPrivatePageHead, createSocialPageHead } from './social-meta';

describe('createSocialPageHead', () => {
  it('returns complete metadata with absolute canonical and image URLs', () => {
    const head = createSocialPageHead({
      title: 'Built with Ghostbuild',
      description: 'Open a shared project.',
      path: '/share/example',
      imagePath: '/social-preview-share-v2.png',
      imageAlt: 'Ghostbuild ghost logo',
    });

    expect(head.links).toEqual([{ rel: 'canonical', href: 'https://ghostbuild.dev/share/example' }]);
    expect(head.meta).toEqual(
      expect.arrayContaining([
        { property: 'og:url', content: 'https://ghostbuild.dev/share/example' },
        { property: 'og:image', content: 'https://ghostbuild.dev/social-preview-share-v2.png' },
        { property: 'og:image:width', content: '1200' },
        { property: 'og:image:height', content: '630' },
        { name: 'twitter:card', content: 'summary_large_image' },
        { name: 'twitter:image', content: 'https://ghostbuild.dev/social-preview-share-v2.png' },
      ]),
    );
  });
});

describe('createPrivatePageHead', () => {
  it('keeps account and project routes out of search indexes', () => {
    expect(createPrivatePageHead('Settings | Ghostbuild', 'Manage your account.')).toEqual({
      meta: [
        { title: 'Settings | Ghostbuild' },
        { name: 'description', content: 'Manage your account.' },
        { name: 'robots', content: 'noindex, nofollow' },
      ],
    });
  });
});
