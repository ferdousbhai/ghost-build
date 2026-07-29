import { describe, expect, test } from 'vitest';
import type { GhostbuildMessage, GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { toolSuccess } from 'ghostbuild-agent/tool-result';
import {
  getBuildToolChoice,
  getNextServerToolStepSettings,
  getWorkersAiToolSettings,
  type AgentToolSettings,
} from './workers-ai-tools';

describe('Workers AI structured tool policy', () => {
  test('moves server operations through validation and exact-revision deployment in one turn', () => {
    const fallback: AgentToolSettings = { activeTools: ['writeFile'], toolChoice: 'required' };
    expect(getNextServerToolStepSettings([{ toolName: 'writeFile', output: toolSuccess('wrote') }], fallback)).toEqual({
      activeTools: ['validateProject'],
      toolChoice: 'required',
    });
    expect(
      getNextServerToolStepSettings(
        [
          {
            toolName: 'validateProject',
            output: toolSuccess('valid', {
              level: 'full',
              revision: 'a'.repeat(64),
              nextAction: 'prepare-deployment',
            }),
          },
        ],
        fallback,
      ),
    ).toEqual({ activeTools: ['deploy'], toolChoice: 'required' });
    expect(
      getNextServerToolStepSettings(
        [{ toolName: 'deploy', output: toolSuccess('ready', { state: 'awaiting-approval' }) }],
        fallback,
      ),
    ).toEqual({ toolChoice: 'none' });
    expect(getNextServerToolStepSettings([{ toolName: 'view', output: toolSuccess('viewed') }], fallback)).toBe(
      fallback,
    );
  });

  test('requires validation after a successful mutation', () => {
    const messages = [
      user('Build a tracker app'),
      toolResult('writeFile', { path: '/home/project/src/routes/index.tsx' }, toolSuccess('wrote')),
    ];
    expect(getBuildToolChoice(messages)).toEqual({ type: 'tool', toolName: 'validateProject' });
  });

  test('finishes a guest build after revision-bound validation', () => {
    const messages = [
      user('Build a tracker app'),
      toolResult('writeFile', { path: '/home/project/src/routes/index.tsx' }, toolSuccess('wrote')),
      toolResult(
        'validateProject',
        {},
        toolSuccess('valid', { level: 'full', revision: 'abc', nextAction: 'sign-in-required' }),
      ),
    ];
    expect(getBuildToolChoice(messages)).toBe('none');
  });

  test('requires a production plan after signed-in validation and stops after the plan exists', () => {
    const base = [
      user('Build a tracker app'),
      toolResult('writeFile', { path: '/home/project/src/routes/index.tsx' }, toolSuccess('wrote')),
      toolResult(
        'validateProject',
        {},
        toolSuccess('valid', { level: 'full', revision: 'abc', nextAction: 'prepare-deployment' }),
      ),
    ];
    expect(getBuildToolChoice(base)).toEqual({ type: 'tool', toolName: 'deploy' });
    expect(
      getBuildToolChoice([
        ...base,
        toolResult(
          'deploy',
          { validatedRevision: 'abc' },
          toolSuccess('ready', { state: 'awaiting-approval', revision: 'abc' }),
        ),
      ]),
    ).toBe('none');
  });

  test('does not accept a malformed validation receipt', () => {
    const messages = [
      user('Build a tracker app'),
      toolResult('writeFile', { path: '/home/project/src/routes/index.tsx' }, toolSuccess('wrote')),
      toolResult('validateProject', {}, toolSuccess('valid', { revision: 'abc', nextAction: 'sign-in-required' })),
    ];
    expect(getBuildToolChoice(messages)).toBe('required');
  });

  test('activates diagnostic continuation only after incomplete diagnostics exist', () => {
    expect(getWorkersAiToolSettings([user('Explain this project')]).activeTools).not.toContain('getDiagnostics');
    const diagnosticsId = crypto.randomUUID();
    const incomplete = toolSuccess(
      'page',
      { diagnosticsId },
      { complete: false, start: 0, end: 40, total: 42, nextCursor: '12000' },
    );
    expect(
      getWorkersAiToolSettings([user('Explain this project'), toolResult('validateProject', {}, incomplete)])
        .activeTools,
    ).toContain('getDiagnostics');

    const complete = toolSuccess('last page', { diagnosticsId }, { complete: true, start: 40, end: 42, total: 42 });
    expect(
      getWorkersAiToolSettings([
        user('Explain this project'),
        toolResult('validateProject', {}, incomplete),
        toolResult('getDiagnostics', { diagnosticsId, cursor: '12000' }, complete),
      ]).activeTools,
    ).not.toContain('getDiagnostics');

    expect(
      getWorkersAiToolSettings([
        user('Explain this project'),
        toolResult('validateProject', {}, incomplete),
        user('Now explain something else'),
      ]).activeTools,
    ).not.toContain('getDiagnostics');
  });
});

function user(text: string): GhostbuildMessage {
  return { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] };
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
