import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ExistingChatSessionView } from './ExistingChat.client';
import { Header } from './header/Header';
import { RootNotFoundComponent } from '~/routes/__root';
import { SettingsRouteView } from '~/routes/settings';
import { CloudflareCard } from './settings/CloudflareCard.client';

describe('launch route states', () => {
  it('gives signed-out settings visitors an explicit Cloudflare handoff', () => {
    const html = renderToStaticMarkup(<SettingsRouteView authKind="unauthenticated" />);

    expect(html).toContain('Connect Cloudflare to open settings');
    expect(html).toContain('Back to Ghostbuild');
  });

  it('distinguishes session loading from a signed-out direct project link', () => {
    expect(renderToStaticMarkup(<ExistingChatSessionView chatId="project-1" sessionId={undefined} />)).toContain(
      'Checking your Cloudflare session',
    );

    const signedOut = renderToStaticMarkup(<ExistingChatSessionView chatId="project-1" sessionId={null} />);
    expect(signedOut).toContain('Connect Cloudflare to open this project');
    expect(signedOut).toContain('Back to Ghostbuild');
  });

  it('renders a branded, semantic root not-found state', () => {
    const html = renderToStaticMarkup(<RootNotFoundComponent />);

    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('This page does not exist');
    expect(html).toContain('Back to Ghostbuild');
  });

  it('keeps the signed-out header focused on brand while the composer owns connection', () => {
    const html = renderToStaticMarkup(<Header />);

    expect(html).toContain('py-1.5');
    expect(html).toContain('sm:py-3');
    expect(html).not.toContain('Connect Cloudflare');
    expect(html).not.toContain('Sponsor');
  });

  it('discloses the preview-only Cloudflare Computer dependency in settings', () => {
    const html = renderToStaticMarkup(<CloudflareCard />);

    expect(html).toContain('Cloudflare Computer 0.1.1');
    expect(html).toContain('preview with an unstable API');
    expect(html).toContain('does not designate for production use');
  });
});
