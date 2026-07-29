// @vitest-environment jsdom

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProjectTitle } from './ProjectTitle';

describe('ProjectTitle', () => {
  it('renders generated inline Markdown without exposing its markers', () => {
    document.body.innerHTML = renderToStaticMarkup(<ProjectTitle>**Pocket Poll**</ProjectTitle>);

    expect(document.body.innerHTML).toContain('<strong>Pocket Poll</strong>');
    expect(document.body.textContent).toBe('Pocket Poll');
  });

  it('unwraps links and drops raw HTML so a title stays non-interactive', () => {
    document.body.innerHTML = renderToStaticMarkup(
      <ProjectTitle>{'[Pocket Poll](https://example.com) <img src=x onerror=alert(1) />'}</ProjectTitle>,
    );

    expect(document.body.textContent).toBe('Pocket Poll ');
    expect(document.body.querySelector('a')).toBeNull();
    expect(document.body.querySelector('img')).toBeNull();
  });
});
