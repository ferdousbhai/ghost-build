import { describe, expect, it } from 'vitest';
import { summarizeToolInvocationForPrompt } from './message-conversion';

describe('summarizeToolInvocationForPrompt', () => {
  it('keeps deploy failure details so the model can repair preview errors', () => {
    const summary = summarizeToolInvocationForPrompt({
      toolCallId: 'deploy-1',
      toolName: 'deploy',
      args: {},
      state: 'result',
      result:
        'Error: Preview did not render cleanly before timeout: preview returned HTTP 500\nInvalid or unexpected token',
    });

    expect(summary).toContain('deploy');
    expect(summary).toContain('failed');
    expect(summary).toContain('Preview did not render cleanly');
    expect(summary).toContain('Invalid or unexpected token');
  });

  it('preserves guest preview success markers without including full file writes in args', () => {
    const summary = summarizeToolInvocationForPrompt({
      toolCallId: 'write-1',
      toolName: 'writeFile',
      args: {
        path: '/home/project/src/routes/index.tsx',
        content: 'x'.repeat(20_000),
      },
      state: 'result',
      result: 'Ghostbuild preview validation complete. Sign in to deploy this app to Cloudflare production.',
    });

    expect(summary).toContain('"contentLength":20000');
    expect(summary).not.toContain('x'.repeat(1_000));
    expect(summary).toContain('Ghostbuild preview validation complete');
  });
});
