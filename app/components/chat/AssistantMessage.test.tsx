// @vitest-environment jsdom

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { AssistantMessage } from './AssistantMessage';

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

    expect(document.body.textContent).toContain('Approve production deployment');
    expect(document.body.textContent).toContain('1 Cloudflare resources');
    expect(document.body.textContent).not.toContain('deployment-1');
  });
});
