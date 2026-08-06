import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => (
      <a {...props} href={to}>
        {children}
      </a>
    ),
  };
});
import { ClientExistingChat, ClientHeader, ClientHomepage, ClientSettingsContent } from './ClientRouteComponents';
import { HOME_HERO_LEDE } from '~/lib/trust';

describe('client route loading fallbacks', () => {
  it('renders useful homepage content before client-only chunks hydrate', () => {
    const html = renderToStaticMarkup(
      <>
        <ClientHeader />
        <ClientHomepage initialId="project-1" />
      </>,
    );

    expect(html).toContain('Ghostbuild');
    expect(html).toContain('If you can dream it');
    expect(html).toContain(HOME_HERO_LEDE);
    expect(html).toContain('Loading the prompt editor');
  });

  it('renders deterministic loading states for direct private-route navigation', () => {
    expect(renderToStaticMarkup(<ClientExistingChat chatId="project-1" />)).toContain('Loading project');
    expect(renderToStaticMarkup(<ClientSettingsContent />)).toContain('Loading settings');
  });
});
