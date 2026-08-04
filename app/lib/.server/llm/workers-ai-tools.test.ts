import { describe, expect, it } from 'vitest';
import type { GhostbuildMessage, GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { toolFailure, toolSuccess } from 'ghostbuild-agent/tool-result';
import {
  createTurnStatefulToolCoordinator,
  createTurnToolCallGuard,
  getValidatedBuildCompletion,
  getWorkersAiToolSettings,
} from './workers-ai-tools';

const AUTOMATIC_TOOLS = ['read', 'ls', 'edit', 'write', 'exec', 'lookupDocs', 'npmInstall', 'validateProject'];

describe('Workers AI tool lifecycle', () => {
  it('serializes writes and validation in model tool-call order', async () => {
    const coordinate = createTurnStatefulToolCoordinator();
    let finishWrite: (() => void) | undefined;
    const events: string[] = [];
    const write = coordinate('write', async () => {
      events.push('write-start');
      await new Promise<void>((resolve) => {
        finishWrite = resolve;
      });
      events.push('write-end');
    });
    const validation = coordinate('validateProject', async () => {
      events.push('validate-start');
    });

    await Promise.resolve();
    expect(events).toEqual(['write-start']);
    finishWrite?.();
    await Promise.all([write, validation]);
    expect(events).toEqual(['write-start', 'write-end', 'validate-start']);
  });

  it('does not let a failed stateful tool block the remaining turn', async () => {
    const coordinate = createTurnStatefulToolCoordinator();
    const failedWrite = coordinate('write', async () => {
      throw new Error('write failed');
    });
    const validation = coordinate('validateProject', async () => 'validated');

    await expect(failedWrite).rejects.toThrow('write failed');
    await expect(validation).resolves.toBe('validated');
  });

  it('rejects duplicate calls in one turn while allowing durable replay and changed arguments', () => {
    const guard = createTurnToolCallGuard();
    expect(guard('read', { path: '/home/project/package.json', offset: 1, limit: 20 }, 'call-1', 1)).toBeUndefined();
    expect(guard('read', { limit: 20, path: '/home/project/package.json', offset: 1 }, 'call-1', 1)).toBeUndefined();
    expect(guard('read', { limit: 20, path: '/home/project/package.json', offset: 1 }, 'call-2', 1)).toBe(
      'This exact tool call already ran in the current turn. Use its result or try a different approach.',
    );
    expect(guard('read', { path: '/home/project/package.json', offset: 20, limit: 20 }, 'call-3', 1)).toBeUndefined();
    expect(guard('read', { path: '/home/project/package.json', offset: 1, limit: 20 }, 'call-4', 2)).toBeUndefined();
  });

  it('gives the model all non-deployment tools before a mutation', () => {
    expect(getWorkersAiToolSettings([user('Build a habit tracker')])).toEqual({
      activeTools: AUTOMATIC_TOOLS,
      toolChoice: 'auto',
    });

    expect(
      getWorkersAiToolSettings([
        user('Build a habit tracker'),
        toolResult('read', {}, { path: '/home/project/package.json', content: '{}' }),
        toolResult('lookupDocs', {}, toolSuccess('looked up guidance')),
      ]),
    ).toEqual({
      activeTools: AUTOMATIC_TOOLS,
      toolChoice: 'auto',
    });
  });

  it('requires concrete implementation or validation work after a successful current-turn mutation', () => {
    expect(
      getWorkersAiToolSettings([
        user('Build a habit tracker'),
        toolResult('write', { path: '/home/project/src/router.tsx' }, writeResult()),
      ]),
    ).toEqual({
      activeTools: AUTOMATIC_TOOLS,
      toolChoice: 'required',
    });
  });

  it('treats exec as implementation only when Computer reports a workspace mutation', () => {
    expect(
      getWorkersAiToolSettings([
        user('Explain the project'),
        toolResult('exec', { command: 'rg TODO' }, { exitCode: 0, stdout: '', stderr: '', workspaceChanged: false }),
      ]),
    ).toEqual({ activeTools: AUTOMATIC_TOOLS, toolChoice: 'auto' });

    expect(
      getWorkersAiToolSettings([
        user('Update the project'),
        toolResult(
          'exec',
          { command: 'pnpm lint --fix' },
          {
            exitCode: 0,
            stdout: '',
            stderr: '',
            workspaceChanged: true,
          },
        ),
      ]),
    ).toEqual({ activeTools: AUTOMATIC_TOOLS, toolChoice: 'required' });
  });

  it('requires implementation work after dependency setup instead of forcing premature validation', () => {
    expect(
      getWorkersAiToolSettings([
        user('Build a Three.js game'),
        toolResult('npmInstall', { packages: 'three @types/three' }, toolSuccess('installed')),
      ]),
    ).toEqual({
      activeTools: AUTOMATIC_TOOLS.filter((toolName) => toolName !== 'validateProject'),
      toolChoice: 'required',
    });
  });

  it('uses every result in a multi-tool model step', () => {
    expect(
      getWorkersAiToolSettings(
        [user('Build a habit tracker')],
        [
          { toolName: 'write', result: writeResult() },
          { toolName: 'read', result: { path: '/home/project/package.json', content: '{}' } },
        ],
      ),
    ).toEqual({
      activeTools: AUTOMATIC_TOOLS,
      toolChoice: 'required',
    });
  });

  it('finishes an unfinished mutation before starting a later turn', () => {
    expect(
      getWorkersAiToolSettings([
        user('Build a habit tracker'),
        toolResult('write', { path: '/home/project/src/routes/index.tsx' }, writeResult()),
        { ...user('Is it ready?'), id: 'user-2' },
      ]),
    ).toEqual({
      activeTools: ['validateProject'],
      toolChoice: 'required',
    });
  });

  it('returns control after read failures and requires repair work after validation failures', () => {
    expect(
      getWorkersAiToolSettings([
        user('Explain the project'),
        toolResult('read', {}, { error: 'Unable to read that range' }),
      ]),
    ).toEqual({
      activeTools: AUTOMATIC_TOOLS,
      toolChoice: 'auto',
    });

    expect(
      getWorkersAiToolSettings([
        user('Build a habit tracker'),
        toolResult('write', {}, writeResult()),
        toolResult('validateProject', {}, toolFailure('Preview validation failed')),
      ]),
    ).toEqual({
      activeTools: AUTOMATIC_TOOLS,
      toolChoice: 'required',
    });

    expect(
      getWorkersAiToolSettings([
        user('Build a habit tracker'),
        toolResult('write', {}, writeResult()),
        toolResult('validateProject', {}, toolSuccess('missing next action', { level: 'full', revision: 'abc' })),
      ]),
    ).toEqual({
      activeTools: AUTOMATIC_TOOLS,
      toolChoice: 'required',
    });
  });

  it('prepares deployment only after exact-revision validation', () => {
    const messages = [
      user('Build a habit tracker'),
      toolResult('write', {}, writeResult()),
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
      toolChoice: 'required',
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
        toolResult('write', {}, writeResult()),
        toolResult('validateProject', {}, validationResult('sign-in-required')),
      ]),
    ).toEqual({ toolChoice: 'none' });
  });

  it('returns deterministic completion copy from validated lifecycle receipts', () => {
    expect(
      getValidatedBuildCompletion([
        user('Build a habit tracker'),
        toolResult('write', {}, writeResult()),
        toolResult('validateProject', {}, validationResult('sign-in-required')),
      ]),
    ).toBe(
      'Done. I built and validated the app in the isolated production build environment, and it is ready to preview here. Sign in when you are ready to deploy it to Cloudflare production.',
    );
  });

  it('returns deterministic approval copy from tool results produced in the current model call', () => {
    expect(
      getValidatedBuildCompletion(
        [user('Build a habit tracker')],
        [
          { toolName: 'write', result: writeResult() },
          { toolName: 'validateProject', result: validationResult('prepare-deployment') },
          {
            toolName: 'deploy',
            result: toolSuccess('ready', { state: 'awaiting-approval', revision: 'a'.repeat(64) }),
          },
        ],
      ),
    ).toBe('Done. I built and validated the app. The production deployment plan is ready for your approval.');
  });

  it('does not complete from an obsolete successful validation receipt', () => {
    const messages = [
      user('Build a habit tracker'),
      toolResult('write', {}, writeResult()),
      toolResult('validateProject', {}, validationResult('sign-in-required')),
      toolResult('validateProject', {}, toolFailure('The project no longer validates')),
    ];

    expect(getWorkersAiToolSettings(messages)).toEqual({
      activeTools: AUTOMATIC_TOOLS,
      toolChoice: 'required',
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

function writeResult() {
  return { path: '/home/project/src/routes/index.tsx', bytesWritten: 42 };
}
