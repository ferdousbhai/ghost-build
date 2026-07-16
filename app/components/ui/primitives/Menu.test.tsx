// @vitest-environment jsdom

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { Menu, MenuItem } from './Menu';

describe('Menu', () => {
  test('uses an accessible menu button instead of a clipped native details element', () => {
    document.body.innerHTML = renderToStaticMarkup(
      <Menu buttonProps={{ title: 'User menu', variant: 'neutral', icon: <span>Avatar</span> }}>
        <MenuItem>Settings</MenuItem>
      </Menu>,
    );

    const trigger = document.querySelector('button[aria-label="User menu"]');

    expect(trigger?.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger?.textContent).toContain('Avatar');
    expect(document.querySelector('details')).toBeNull();
  });
});
