// @vitest-environment jsdom

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { DEPLOYMENT_PLAN_MARKER } from '~/lib/deployment-approval';
import { AssistantMessage } from './AssistantMessage';

vi.mock('./ToolCall', () => ({ ToolCall: () => null }));
vi.mock('./Markdown', () => ({ Markdown: ({ children }: { children: string }) => <span>{children}</span> }));

describe('AssistantMessage deployment approval', () => {
  it('renders a carried-forward approval card without exposing its machine marker', () => {
    const marker = `${DEPLOYMENT_PLAN_MARKER}${JSON.stringify({
      id: 'deployment-1',
      planDigest: 'a'.repeat(64),
      resources: [{ type: 'worker', logicalName: 'app', proposedName: 'ghostbuild-app' }],
    })}`;
    const message: GhostbuildMessage = {
      id: 'assistant-1',
      role: 'assistant',
      parts: [{ type: 'text', text: `Review and approve below.\n\n${marker}` }],
    };

    document.body.innerHTML = renderToStaticMarkup(<AssistantMessage message={message} />);

    expect(document.body.textContent).toContain('Approve production deployment');
    expect(document.body.textContent).toContain('1 Cloudflare resources');
    expect(document.body.textContent).not.toContain(DEPLOYMENT_PLAN_MARKER);
  });
});
