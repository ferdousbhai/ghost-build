// @vitest-environment jsdom

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { AssistantMessage } from './AssistantMessage';

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
vi.mock('./ToolCall', () => ({ ToolCall: () => null }));
vi.mock('./Markdown', () => ({ Markdown: ({ children }: { children: string }) => <span>{children}</span> }));

describe('AssistantMessage deployment continuation', () => {
  it('does not render a duplicate deployment control', () => {
    const deployment = {
      id: 'deployment-1',
      planDigest: 'a'.repeat(64),
      resources: [{ type: 'worker', logicalName: 'app', proposedName: 'ghostbuild-app' }],
    };
    const message: GhostbuildMessage = {
      id: 'assistant-1',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Review and approve below.' },
        { type: 'data-deployment-approval', data: deployment },
      ],
    };

    document.body.innerHTML = renderToStaticMarkup(<AssistantMessage message={message} />);

    expect(document.body.textContent).not.toContain('Ready to deploy');
    expect(document.body.textContent).not.toContain('deployment-1');
  });
});
