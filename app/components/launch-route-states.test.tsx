import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    Link: ({ children, to, hash, ...props }: { children: React.ReactNode; to: string; hash?: string }) => (
      <a {...props} href={`${to}${hash ? `#${hash}` : ''}`}>
        {children}
      </a>
    ),
    useNavigate: () => vi.fn(),
  };
});
import { ExistingChatSessionView, ProjectLoadError } from './ExistingChat.client';
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

  it('gives a failed Cloudflare authorization a safe retry path', () => {
    const html = renderToStaticMarkup(
      <SettingsRouteView
        authKind="unauthenticated"
        authorizationError="Cloudflare couldn't authorize this connection. Please try again."
      />,
    );

    expect(html).toContain('Cloudflare couldn&#x27;t authorize this connection. Please try again.');
    expect(html).toContain('Connect Cloudflare');
    expect(html).toContain('Back to Ghostbuild');
  });

  it('distinguishes session loading from a signed-out direct project link', () => {
    expect(renderToStaticMarkup(<ExistingChatSessionView chatId="project-1" userId={undefined} />)).toContain(
      'Checking your Cloudflare session',
    );

    const signedOut = renderToStaticMarkup(<ExistingChatSessionView chatId="project-1" userId={null} />);
    expect(signedOut).toContain('Connect Cloudflare to open this project');
    expect(signedOut).toContain('Back to Ghostbuild');
  });

  it('replaces a failed cold project load with a retryable error instead of an endless spinner', () => {
    const html = renderToStaticMarkup(<ProjectLoadError error={new Error('Runtime unavailable')} onRetry={vi.fn()} />);

    expect(html).toContain('Ghostbuild could not load this project');
    expect(html).toContain('Runtime unavailable');
    expect(html).toContain('Try again');
    expect(html).not.toContain('Loading project');
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

  it('states the Cloudflare plan requirements without an internal runtime warning', () => {
    const html = renderToStaticMarkup(<CloudflareCard />);

    expect(html).toContain('Requires Cloudflare Workers Paid and Containers.');
    expect(html).not.toContain('Cloudflare Computer');
  });
});
