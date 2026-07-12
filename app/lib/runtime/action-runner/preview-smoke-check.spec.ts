import { describe, expect, it } from 'vitest';
import { createPreviewSmokeCheckScript } from './preview-smoke-check';

describe('createPreviewSmokeCheckScript', () => {
  it('embeds the configured port, timeout, and failure checks', () => {
    const source = createPreviewSmokeCheckScript(4173, 12_000);

    expect(source).toContain('http://127.0.0.1:4173/');
    expect(source).toContain('Date.now() + 12000');
    expect(source).toContain('Preview did not render cleanly before timeout');
  });
});
