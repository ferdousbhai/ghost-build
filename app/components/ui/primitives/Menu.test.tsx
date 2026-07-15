// @vitest-environment jsdom

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { Menu, MenuItem } from './Menu';

describe('Menu', () => {
  test('uses the summary itself as the accessible trigger and keeps the dropdown outside normal flow', () => {
    document.body.innerHTML = renderToStaticMarkup(
      <Menu buttonProps={{ title: 'User menu', variant: 'neutral', icon: <span>Avatar</span> }}>
        <MenuItem>Settings</MenuItem>
      </Menu>,
    );

    const summary = document.querySelector('summary');
    const dropdown = document.querySelector('details > div');

    expect(summary?.getAttribute('aria-label')).toBe('User menu');
    expect(summary?.querySelector('button')).toBeNull();
    expect(dropdown?.classList.contains('fixed')).toBe(true);
  });
});
