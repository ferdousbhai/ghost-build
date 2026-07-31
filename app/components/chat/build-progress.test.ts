import { describe, expect, it } from 'vitest';
import { BUILD_PROGRESS_DELAY_MS, BUILD_PROGRESS_STALL_MS, getBuildProgress } from './build-progress';

describe('getBuildProgress', () => {
  it('shows a meaningful phase instead of an unexplained loader', () => {
    expect(
      getBuildProgress({ streamStatus: 'submitted', isRecovering: false, activeToolNames: [], inactiveForMs: 0 }),
    ).toMatchObject({ phase: 'planning', message: 'Planning your project…', delayed: false, stalled: false });
    expect(
      getBuildProgress({ streamStatus: 'streaming', isRecovering: false, activeToolNames: [], inactiveForMs: 0 }),
    ).toMatchObject({ phase: 'creating', message: 'Creating your project…' });
  });

  it.each([
    ['writeFile', 'saving', 'Saving changes…'],
    ['edit', 'saving', 'Saving changes…'],
    ['npmInstall', 'installing', 'Installing dependencies…'],
    ['validateProject', 'validating', 'Validating your project…'],
    ['deploy', 'checking', 'Checking that everything works…'],
  ] as const)('translates %s into concise user-facing progress', (toolName, phase, message) => {
    expect(
      getBuildProgress({
        streamStatus: 'streaming',
        isRecovering: false,
        activeToolNames: [toolName],
        inactiveForMs: 0,
      }),
    ).toMatchObject({ phase, message });
  });

  it('communicates delays and stalls without exposing internal identifiers', () => {
    const delayed = getBuildProgress({
      streamStatus: 'streaming',
      isRecovering: false,
      activeToolNames: ['writeFile'],
      inactiveForMs: BUILD_PROGRESS_DELAY_MS,
    });
    const stalled = getBuildProgress({
      streamStatus: 'streaming',
      isRecovering: false,
      activeToolNames: ['writeFile'],
      inactiveForMs: BUILD_PROGRESS_STALL_MS,
    });
    expect(delayed).toMatchObject({ delayed: true, stalled: false });
    expect(delayed?.message).toBe('Taking longer than usual — still saving changes');
    expect(stalled).toMatchObject({ delayed: true, stalled: true });
    expect(stalled?.message).toBe('This may be stuck — last progress: saving changes');
    expect(stalled?.message).not.toMatch(/(?:request|tool|call)[-_ ]?id/i);
  });

  it('prioritizes recovery and returns nothing after the turn ends', () => {
    expect(
      getBuildProgress({
        streamStatus: 'submitted',
        isRecovering: true,
        activeToolNames: ['writeFile'],
        inactiveForMs: 0,
      }),
    ).toMatchObject({ phase: 'recovering', message: 'Recovering the interrupted build…' });
    expect(
      getBuildProgress({ streamStatus: 'ready', isRecovering: false, activeToolNames: [], inactiveForMs: 0 }),
    ).toBeNull();
  });
});
