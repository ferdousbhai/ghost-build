import { describe, expect, it } from 'vitest';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { toolFailure, toolSuccess } from 'ghostbuild-agent/tool-result';
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

function toolResult(toolName: string, result: unknown, args: Record<string, unknown> = {}): GhostbuildMessage {
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

function validationResult(nextAction: 'sign-in-required' | 'prepare-deployment', revision = 'a'.repeat(64)) {
  return toolSuccess('validated', { level: 'full', revision, nextAction });
}

describe('getBuildToolChoice', () => {
  it('allows discovery and skill lookup before a build changes files', () => {
    expect(getBuildToolChoice([userMessage('Build a habit tracker app')])).toBe('auto');

    expect(getBuildToolChoice([userMessage('How does this app work?')])).toBe('auto');

    expect(
      getBuildToolChoice([
        userMessage('Build a habit tracker app'),
        toolResult('view', 'src/routes/index.tsx contents'),
        toolResult('lookupDocs', 'Cloudflare and frontend design guidance'),
      ]),
    ).toBe('auto');
  });

  it('requires validation after a file change', () => {
    expect(
      getBuildToolChoice([
        userMessage('Build a habit tracker app'),
        toolResult('writeFile', 'Wrote src/routes/index.tsx', { path: '/home/project/src/routes/index.tsx' }),
      ]),
    ).toEqual({
      type: 'tool',
      toolName: 'validateProject',
    });
  });

  it('requires validation after any mutation without prescribing the initial mutation', () => {
    expect(
      getBuildToolChoice([
        userMessage('Build a habit tracker app'),
        toolResult('writeFile', 'Wrote src/router.tsx', { path: '/home/project/src/router.tsx' }),
      ]),
    ).toEqual({
      type: 'tool',
      toolName: 'validateProject',
    });
  });

  it('still requires validation when a new user turn follows an unvalidated mutation', () => {
    expect(
      getBuildToolChoice([
        userMessage('Build a habit tracker app'),
        toolResult('writeFile', 'Wrote src/routes/index.tsx', { path: '/home/project/src/routes/index.tsx' }),
        { ...userMessage('Is it ready?'), id: 'user-2' },
      ]),
    ).toEqual({ type: 'tool', toolName: 'validateProject' });
  });

  it('requires continued tool work after failed validation without prescribing the repair tool', () => {
    expect(
      getBuildToolChoice([
        userMessage('Build a habit tracker app'),
        toolResult('writeFile', 'Wrote src/routes/index.tsx', { path: '/home/project/src/routes/index.tsx' }),
        toolResult('validateProject', toolFailure('Preview validation failed')),
      ]),
    ).toBe('required');
  });

  it('keeps an unvalidated mutation on the validation path after another tool fails', () => {
    expect(
      getBuildToolChoice([
        userMessage('Build a habit tracker app'),
        toolResult('writeFile', 'Wrote src/router.tsx', { path: '/home/project/src/router.tsx' }),
        toolResult('deploy', 'Error: Generated app route still matches the starter template: src/routes/index.tsx'),
      ]),
    ).toEqual({
      type: 'tool',
      toolName: 'validateProject',
    });
  });

  it('keeps all repair tools available after failed validation and repeated reads', () => {
    expect(
      getBuildToolChoice([
        userMessage('Build a habit tracker app'),
        toolResult('writeFile', 'Wrote src/routes/index.tsx', { path: '/home/project/src/routes/index.tsx' }),
        toolResult('validateProject', toolFailure('Preview validation failed')),
        toolResult('view', 'src/routes/index.tsx contents'),
        toolResult('lookupDocs', 'Cloudflare docs excerpt'),
        toolResult('view', 'package.json contents'),
      ]),
    ).toBe('required');
  });

  it('disables tools after a signed-in deployment plan succeeds', () => {
    expect(
      getBuildToolChoice([
        userMessage('Build a habit tracker app'),
        toolResult('writeFile', 'Wrote src/routes/index.tsx', { path: '/home/project/src/routes/index.tsx' }),
        toolResult('validateProject', validationResult('prepare-deployment')),
        toolResult('deploy', toolSuccess('ready', { state: 'awaiting-approval', revision: 'a'.repeat(64) }), {
          validatedRevision: 'a'.repeat(64),
        }),
      ]),
    ).toBe('none');
  });

  it('treats guest app checks as successful validation', () => {
    expect(
      getBuildToolChoice([
        userMessage('Build a habit tracker app'),
        toolResult('writeFile', 'Wrote src/routes/index.tsx', { path: '/home/project/src/routes/index.tsx' }),
        toolResult('validateProject', validationResult('sign-in-required')),
      ]),
    ).toBe('none');
  });

  it('returns a deterministic guest completion after a successful app check', () => {
    expect(
      getValidatedBuildCompletion([
        userMessage('Build a habit tracker app'),
        toolResult('writeFile', 'Wrote src/routes/index.tsx', { path: '/home/project/src/routes/index.tsx' }),
        toolResult('validateProject', validationResult('sign-in-required')),
      ]),
    ).toBe(
      'Done. I built and validated the app in the isolated production build environment, and it is ready to preview here. Sign in when you are ready to deploy it to Cloudflare production.',
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

  it('keeps discovery and skill tools available initially, then enforces validation sequencing', () => {
    expect(getWorkersAiToolSettings([userMessage('Build a habit tracker app')])).toEqual({
      activeTools: ['view', 'listFiles', 'searchText', 'edit', 'writeFile', 'lookupDocs', 'npmInstall'],
      toolChoice: 'auto',
    });

    expect(
      getWorkersAiToolSettings([
        userMessage('Build a habit tracker app'),
        toolResult('writeFile', 'Wrote src/routes/index.tsx', { path: '/home/project/src/routes/index.tsx' }),
      ]),
    ).toEqual({
      activeTools: ['validateProject'],
      toolChoice: 'required',
    });

    expect(
      getWorkersAiToolSettings([
        userMessage('Build a habit tracker app'),
        toolResult('writeFile', 'Wrote src/routes/index.tsx', { path: '/home/project/src/routes/index.tsx' }),
        toolResult('validateProject', validationResult('sign-in-required')),
      ]),
    ).toEqual({
      toolChoice: 'none',
    });
  });

  it('adds route-specific guidance for new app builds until the user-facing route changes', () => {
    const guidance = getWorkersAiBuildGuidance([userMessage('Build a habit tracker app')]);
    expect(guidance).toContain('/home/project/src/routes/index.tsx');
    expect(guidance).toContain('consult lookupDocs before choosing the implementation');
    expect(guidance).not.toContain('Your next filesystem action must');

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
