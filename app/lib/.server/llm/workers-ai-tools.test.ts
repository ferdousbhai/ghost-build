import { describe, expect, it } from 'vitest';
import type { GhostbuildMessage, GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { toolFailure, toolSuccess } from 'ghostbuild-agent/tool-result';
import { createTurnToolCallGuard, getValidatedBuildCompletion, getWorkersAiToolSettings } from './workers-ai-tools';

const AUTOMATIC_TOOLS = [
  'view',
  'listFiles',
  'searchText',
  'edit',
  'writeFile',
  'lookupDocs',
  'npmInstall',
  'validateProject',
];

describe('Workers AI tool lifecycle', () => {
  it('rejects duplicate calls in one turn while allowing durable replay and changed arguments', () => {
    const guard = createTurnToolCallGuard();
    expect(guard('view', { path: '/home/project/package.json', view_range: [1, 20] }, 'call-1', 1)).toBeUndefined();
    expect(guard('view', { view_range: [1, 20], path: '/home/project/package.json' }, 'call-1', 1)).toBeUndefined();
    expect(guard('view', { view_range: [1, 20], path: '/home/project/package.json' }, 'call-2', 1)).toBe(
      'This exact tool call already ran in the current turn. Use its result or try a different approach.',
    );
    expect(guard('view', { path: '/home/project/package.json', view_range: [20, 40] }, 'call-3', 1)).toBeUndefined();
    expect(guard('view', { path: '/home/project/package.json', view_range: [1, 20] }, 'call-4', 2)).toBeUndefined();
  });

  it('gives the model all non-deployment tools before a mutation', () => {
    expect(getWorkersAiToolSettings([user('Build a habit tracker')])).toEqual({
      activeTools: AUTOMATIC_TOOLS,
      toolChoice: 'auto',
    });

    expect(
      getWorkersAiToolSettings([
        user('Build a habit tracker'),
        toolResult('view', {}, toolSuccess('viewed')),
        toolResult('lookupDocs', {}, toolSuccess('looked up guidance')),
      ]),
    ).toEqual({
      activeTools: AUTOMATIC_TOOLS,
      toolChoice: 'auto',
    });
  });

  it('requires validation after any successful mutation', () => {
    expect(
      getWorkersAiToolSettings([
        user('Build a habit tracker'),
        toolResult('writeFile', { path: '/home/project/src/router.tsx' }, toolSuccess('wrote')),
      ]),
    ).toEqual({
      activeTools: ['validateProject'],
      toolChoice: 'required',
    });
  });

  it('lets implementation continue after dependency setup instead of forcing premature validation', () => {
    expect(
      getWorkersAiToolSettings([
        user('Build a Three.js game'),
        toolResult('npmInstall', { packages: 'three @types/three' }, toolSuccess('installed')),
      ]),
    ).toEqual({
      activeTools: AUTOMATIC_TOOLS,
      toolChoice: 'auto',
    });
  });

  it('uses every result in a multi-tool model step', () => {
    expect(
      getWorkersAiToolSettings(
        [user('Build a habit tracker')],
        [
          { toolName: 'writeFile', result: toolSuccess('wrote') },
          { toolName: 'view', result: toolSuccess('viewed') },
        ],
      ),
    ).toEqual({
      activeTools: ['validateProject'],
      toolChoice: 'required',
    });
  });

  it('finishes an unfinished mutation before starting a later turn', () => {
    expect(
      getWorkersAiToolSettings([
        user('Build a habit tracker'),
        toolResult('writeFile', { path: '/home/project/src/routes/index.tsx' }, toolSuccess('wrote')),
        { ...user('Is it ready?'), id: 'user-2' },
      ]),
    ).toEqual({
      activeTools: ['validateProject'],
      toolChoice: 'required',
    });
  });

  it('returns control to the model after arbitrary tool or validation failures', () => {
    expect(
      getWorkersAiToolSettings([
        user('Explain the project'),
        toolResult('view', {}, toolFailure('Unable to read that range')),
      ]),
    ).toEqual({
      activeTools: AUTOMATIC_TOOLS,
      toolChoice: 'auto',
    });

    expect(
      getWorkersAiToolSettings([
        user('Build a habit tracker'),
        toolResult('writeFile', {}, toolSuccess('wrote')),
        toolResult('validateProject', {}, toolFailure('Preview validation failed')),
      ]),
    ).toEqual({
      activeTools: AUTOMATIC_TOOLS,
      toolChoice: 'auto',
    });

    expect(
      getWorkersAiToolSettings([
        user('Build a habit tracker'),
        toolResult('writeFile', {}, toolSuccess('wrote')),
        toolResult('validateProject', {}, toolSuccess('missing next action', { level: 'full', revision: 'abc' })),
      ]),
    ).toEqual({
      activeTools: AUTOMATIC_TOOLS,
      toolChoice: 'auto',
    });
  });

  it('prepares deployment only after exact-revision validation', () => {
    const messages = [
      user('Build a habit tracker'),
      toolResult('writeFile', {}, toolSuccess('wrote')),
      toolResult('validateProject', {}, validationResult('prepare-deployment', 'abc')),
    ];
    expect(getWorkersAiToolSettings(messages)).toEqual({
      activeTools: ['deploy'],
      toolChoice: 'required',
    });

    expect(
      getWorkersAiToolSettings([
        ...messages,
        toolResult('deploy', { validatedRevision: 'abc' }, toolFailure('Cloudflare is temporarily unavailable')),
      ]),
    ).toEqual({
      activeTools: [...AUTOMATIC_TOOLS, 'deploy'],
      toolChoice: 'auto',
    });

    expect(
      getWorkersAiToolSettings([
        ...messages,
        toolResult(
          'deploy',
          { validatedRevision: 'abc' },
          toolSuccess('ready', { state: 'awaiting-approval', revision: 'abc' }),
        ),
      ]),
    ).toEqual({ toolChoice: 'none' });
  });

  it('stops tool work after guest validation', () => {
    expect(
      getWorkersAiToolSettings([
        user('Build a habit tracker'),
        toolResult('writeFile', {}, toolSuccess('wrote')),
        toolResult('validateProject', {}, validationResult('sign-in-required')),
      ]),
    ).toEqual({ toolChoice: 'none' });
  });

  it('returns deterministic completion copy from validated lifecycle receipts', () => {
    expect(
      getValidatedBuildCompletion([
        user('Build a habit tracker'),
        toolResult('writeFile', {}, toolSuccess('wrote')),
        toolResult('validateProject', {}, validationResult('sign-in-required')),
      ]),
    ).toBe(
      'Done. I built and validated the app in the isolated production build environment, and it is ready to preview here. Sign in when you are ready to deploy it to Cloudflare production.',
    );
  });

  it('does not complete from an obsolete successful validation receipt', () => {
    const messages = [
      user('Build a habit tracker'),
      toolResult('writeFile', {}, toolSuccess('wrote')),
      toolResult('validateProject', {}, validationResult('sign-in-required')),
      toolResult('validateProject', {}, toolFailure('The project no longer validates')),
    ];

    expect(getWorkersAiToolSettings(messages)).toEqual({
      activeTools: AUTOMATIC_TOOLS,
      toolChoice: 'auto',
    });
    expect(getValidatedBuildCompletion(messages)).toBeUndefined();
  });
});

function user(text: string): GhostbuildMessage {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text }],
  };
}

function toolResult(toolName: string, args: unknown, result: unknown): GhostbuildMessage {
  const invocation: GhostbuildToolInvocation = {
    state: 'result',
    toolCallId: crypto.randomUUID(),
    toolName,
    args,
    result,
  };
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    parts: [{ type: 'tool-invocation', toolInvocation: invocation }],
  };
}

function validationResult(nextAction: 'sign-in-required' | 'prepare-deployment', revision = 'a'.repeat(64)) {
  return toolSuccess('validated', {
    level: 'full',
    revision,
    nextAction,
  });
}
