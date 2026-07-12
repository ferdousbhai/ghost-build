import { describe, expect, it } from 'vitest';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import {
  getBuildToolChoice,
  getValidatedBuildCompletion,
  getWorkersAiBuildGuidance,
  getWorkersAiToolSettings,
} from './workers-ai-tools';

function userMessage(text: string): GhostbuildMessage {
  return {
    id: 'user-1',
    role: 'user',
    parts: [{ type: 'text', text }],
  };
}

function toolResult(toolName: string, result: string, args: Record<string, unknown> = {}): GhostbuildMessage {
  return {
    id: `${toolName}-result`,
    role: 'assistant',
    parts: [
      {
        type: 'tool-invocation',
        toolInvocation: {
          state: 'result',
          toolCallId: `${toolName}-call`,
          toolName,
          args,
          result,
        },
      },
    ],
  };
}

describe('getBuildToolChoice', () => {
  it('requires writeFile for build requests until a file is changed', () => {
    expect(getBuildToolChoice([userMessage('Build a habit tracker app')])).toEqual({
      type: 'tool',
      toolName: 'writeFile',
    });

    expect(getBuildToolChoice([userMessage('How does this app work?')])).toBe('auto');

    expect(
      getBuildToolChoice([
        userMessage('Build a habit tracker app'),
        toolResult('view', 'src/routes/index.tsx contents'),
      ]),
    ).toEqual({
      type: 'tool',
      toolName: 'writeFile',
    });
  });

  it('requires deploy after a file change', () => {
    expect(
      getBuildToolChoice([
        userMessage('Build a habit tracker app'),
        toolResult('writeFile', 'Wrote src/routes/index.tsx', { path: '/home/project/src/routes/index.tsx' }),
      ]),
    ).toEqual({
      type: 'tool',
      toolName: 'deploy',
    });
  });

  it('requires a user-facing route change before deploying a new app build', () => {
    expect(
      getBuildToolChoice([
        userMessage('Build a habit tracker app'),
        toolResult('writeFile', 'Wrote src/router.tsx', { path: '/home/project/src/router.tsx' }),
      ]),
    ).toEqual({
      type: 'tool',
      toolName: 'writeFile',
    });
  });

  it('still requires validation when a new user turn follows an unvalidated mutation', () => {
    expect(
      getBuildToolChoice([
        userMessage('Build a habit tracker app'),
        toolResult('writeFile', 'Wrote src/routes/index.tsx', { path: '/home/project/src/routes/index.tsx' }),
        { ...userMessage('Is it ready?'), id: 'user-2' },
      ]),
    ).toEqual({ type: 'tool', toolName: 'deploy' });
  });

  it('requires continued tool work after a failed deploy without prescribing the repair tool', () => {
    expect(
      getBuildToolChoice([
        userMessage('Build a habit tracker app'),
        toolResult('writeFile', 'Wrote src/routes/index.tsx', { path: '/home/project/src/routes/index.tsx' }),
        toolResult('deploy', 'Error: Preview validation failed'),
      ]),
    ).toBe('required');
  });

  it('forces a route rewrite after the app check reports the starter template', () => {
    expect(
      getBuildToolChoice([
        userMessage('Build a habit tracker app'),
        toolResult('writeFile', 'Wrote src/router.tsx', { path: '/home/project/src/router.tsx' }),
        toolResult('deploy', 'Error: Generated app route still matches the starter template: src/routes/index.tsx'),
      ]),
    ).toEqual({
      type: 'tool',
      toolName: 'writeFile',
    });
  });

  it('forces a write after repeated read-only tools follow a failed deploy', () => {
    expect(
      getBuildToolChoice([
        userMessage('Build a habit tracker app'),
        toolResult('writeFile', 'Wrote src/routes/index.tsx', { path: '/home/project/src/routes/index.tsx' }),
        toolResult('deploy', 'Error: Preview validation failed'),
        toolResult('view', 'src/routes/index.tsx contents'),
        toolResult('lookupDocs', 'Cloudflare docs excerpt'),
        toolResult('view', 'package.json contents'),
      ]),
    ).toEqual({
      type: 'tool',
      toolName: 'writeFile',
    });
  });

  it('disables tools after deploy validation succeeds', () => {
    expect(
      getBuildToolChoice([
        userMessage('Build a habit tracker app'),
        toolResult('writeFile', 'Wrote src/routes/index.tsx', { path: '/home/project/src/routes/index.tsx' }),
        toolResult('deploy', 'Ghostbuild preview validation complete'),
      ]),
    ).toBe('none');
  });

  it('treats guest app checks as successful validation', () => {
    expect(
      getBuildToolChoice([
        userMessage('Build a habit tracker app'),
        toolResult('writeFile', 'Wrote src/routes/index.tsx', { path: '/home/project/src/routes/index.tsx' }),
        toolResult('deploy', 'Ghostbuild app check complete. Sign in to deploy this app to Cloudflare production.'),
      ]),
    ).toBe('none');
  });

  it('returns a deterministic guest completion after a successful app check', () => {
    expect(
      getValidatedBuildCompletion([
        userMessage('Build a habit tracker app'),
        toolResult('writeFile', 'Wrote src/routes/index.tsx', { path: '/home/project/src/routes/index.tsx' }),
        toolResult('deploy', 'Ghostbuild app check complete. Sign in to deploy this app to Cloudflare production.'),
      ]),
    ).toBe(
      'Done. I built and checked the app, and it is ready to preview here. Sign in when you are ready to deploy it to Cloudflare production.',
    );
  });

  it('does not return a deterministic completion before validation succeeds', () => {
    expect(
      getValidatedBuildCompletion([
        userMessage('Build a habit tracker app'),
        toolResult('writeFile', 'Wrote src/routes/index.tsx', { path: '/home/project/src/routes/index.tsx' }),
      ]),
    ).toBeUndefined();
  });

  it('limits Workers AI to a single active tool instead of forcing named tools', () => {
    expect(getWorkersAiToolSettings([userMessage('Build a habit tracker app')])).toEqual({
      activeTools: ['writeFile'],
      toolChoice: 'required',
    });

    expect(
      getWorkersAiToolSettings([
        userMessage('Build a habit tracker app'),
        toolResult('writeFile', 'Wrote src/routes/index.tsx', { path: '/home/project/src/routes/index.tsx' }),
      ]),
    ).toEqual({
      activeTools: ['deploy'],
      toolChoice: 'required',
    });

    expect(
      getWorkersAiToolSettings([
        userMessage('Build a habit tracker app'),
        toolResult('writeFile', 'Wrote src/routes/index.tsx', { path: '/home/project/src/routes/index.tsx' }),
        toolResult('deploy', 'Ghostbuild app check complete. Sign in to deploy this app to Cloudflare production.'),
      ]),
    ).toEqual({
      toolChoice: 'none',
    });
  });

  it('adds route-specific guidance for new app builds until the user-facing route changes', () => {
    expect(getWorkersAiBuildGuidance([userMessage('Build a habit tracker app')])).toContain(
      '/home/project/src/routes/index.tsx',
    );

    expect(
      getWorkersAiBuildGuidance([
        userMessage('Build a habit tracker app'),
        toolResult('writeFile', 'Wrote /home/project/.ghost-check.txt', { path: '/home/project/.ghost-check.txt' }),
      ]),
    ).toContain('.ghost-check.txt');

    expect(
      getWorkersAiBuildGuidance([
        userMessage('Build a habit tracker app'),
        toolResult('writeFile', 'Wrote src/routes/index.tsx', { path: '/home/project/src/routes/index.tsx' }),
      ]),
    ).toBeUndefined();
  });
});
