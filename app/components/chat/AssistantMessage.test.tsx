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

describe('AssistantMessage deployment approval', () => {
  it('renders a native deployment approval data part', () => {
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

    expect(document.body.textContent).toContain('Ready to deploy');
    expect(document.body.textContent).toContain('Deploy');
    expect(document.body.textContent).toContain('Cloudflare usage charges may apply');
    expect(document.body.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(document.body.textContent).not.toContain('deployment-1');
  });
});
