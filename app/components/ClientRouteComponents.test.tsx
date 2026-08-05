import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ClientAppProviders,
  ClientExistingChat,
  ClientHeader,
  ClientHomepage,
  ClientSettingsContent,
} from './ClientRouteComponents';
import { HOME_HERO_LEDE } from '~/lib/trust';

describe('client route loading fallbacks', () => {
  it('renders useful homepage content before client-only chunks hydrate', () => {
    const html = renderToStaticMarkup(
      <ClientAppProviders>
        <ClientHeader />
        <ClientHomepage />
      </ClientAppProviders>,
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
