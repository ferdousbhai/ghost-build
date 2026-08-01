import { describe, expect, it } from 'vitest';
import {
  BUILD_PROGRESS_DELAY_MS,
  BUILD_PROGRESS_STALL_MS,
  getBuildProgress,
  RECOVERY_PROGRESS_DELAY_MS,
  RECOVERY_PROGRESS_STALL_MS,
  VALIDATION_PROGRESS_DELAY_MS,
  VALIDATION_PROGRESS_STALL_MS,
} from './build-progress';

describe('getBuildProgress', () => {
  it('shows a meaningful phase instead of an unexplained loader', () => {
    expect(
      getBuildProgress({ streamStatus: 'submitted', isRecovering: false, activeToolNames: [], inactiveForMs: 0 }),
    ).toMatchObject({ phase: 'planning', message: 'Planning your project…', delayed: false, stalled: false });
    expect(
      getBuildProgress({ streamStatus: 'streaming', isRecovering: false, activeToolNames: [], inactiveForMs: 0 }),
    ).toMatchObject({ phase: 'creating', message: 'Creating your project…' });
  });

  it('describes work as changes when starting another chat in an existing project', () => {
    expect(
      getBuildProgress({
        streamStatus: 'submitted',
        isRecovering: false,
        isProjectUpdate: true,
        activeToolNames: [],
        inactiveForMs: 0,
      }),
    ).toMatchObject({ phase: 'planning', message: 'Planning your changes…' });
    expect(
      getBuildProgress({
        streamStatus: 'streaming',
        isRecovering: false,
        isProjectUpdate: true,
        activeToolNames: [],
        inactiveForMs: 0,
      }),
    ).toMatchObject({ phase: 'creating', message: 'Updating your project…' });
    expect(
      getBuildProgress({
        streamStatus: 'streaming',
        isRecovering: false,
        isProjectUpdate: true,
        activeToolNames: [],
        inactiveForMs: BUILD_PROGRESS_DELAY_MS,
      }),
    ).toMatchObject({ message: 'Taking longer than usual — still updating your project' });
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

  it('allows the isolated full validation contract more time than ordinary model activity', () => {
    expect(
      getBuildProgress({
        streamStatus: 'streaming',
        isRecovering: false,
        activeToolNames: ['validateProject'],
        inactiveForMs: BUILD_PROGRESS_STALL_MS,
      }),
    ).toMatchObject({ phase: 'validating', delayed: false, stalled: false, message: 'Validating your project…' });
    expect(
      getBuildProgress({
        streamStatus: 'streaming',
        isRecovering: false,
        activeToolNames: ['validateProject'],
        inactiveForMs: VALIDATION_PROGRESS_DELAY_MS,
      }),
    ).toMatchObject({ delayed: true, stalled: false });
    expect(
      getBuildProgress({
        streamStatus: 'streaming',
        isRecovering: false,
        activeToolNames: ['validateProject'],
        inactiveForMs: VALIDATION_PROGRESS_STALL_MS,
      }),
    ).toMatchObject({ delayed: true, stalled: true });
  });

  it('shows the current isolated validation stage', () => {
    expect(
      getBuildProgress({
        streamStatus: 'streaming',
        isRecovering: false,
        activeToolNames: ['validateProject'],
        validationStage: 'dependency installation',
        inactiveForMs: 0,
      }),
    ).toMatchObject({ phase: 'validating', message: 'Installing validation dependencies…' });
    expect(
      getBuildProgress({
        streamStatus: 'streaming',
        isRecovering: false,
        activeToolNames: ['validateProject'],
        validationStage: 'application build',
        inactiveForMs: VALIDATION_PROGRESS_DELAY_MS,
      }),
    ).toMatchObject({
      delayed: true,
      message: 'Taking longer than usual — still building your project for production',
    });
  });

  it('prioritizes active validation over an overlapping completed mutation', () => {
    expect(
      getBuildProgress({
        streamStatus: 'streaming',
        isRecovering: false,
        activeToolNames: ['writeFile', 'validateProject'],
        inactiveForMs: BUILD_PROGRESS_STALL_MS,
      }),
    ).toMatchObject({
      phase: 'validating',
      message: 'Validating your project…',
      delayed: false,
      stalled: false,
    });
  });

  it('shows recovered tool activity, then recovery while waiting, and nothing after the turn ends', () => {
    expect(
      getBuildProgress({
        streamStatus: 'submitted',
        isRecovering: true,
        activeToolNames: ['writeFile'],
        inactiveForMs: 0,
      }),
    ).toMatchObject({ phase: 'saving', message: 'Saving changes…' });
    expect(
      getBuildProgress({
        streamStatus: 'submitted',
        isRecovering: true,
        activeToolNames: [],
        inactiveForMs: RECOVERY_PROGRESS_DELAY_MS,
      }),
    ).toMatchObject({ delayed: true, stalled: false });
    expect(
      getBuildProgress({
        streamStatus: 'submitted',
        isRecovering: true,
        activeToolNames: [],
        inactiveForMs: RECOVERY_PROGRESS_STALL_MS,
      }),
    ).toMatchObject({ delayed: true, stalled: true });
    expect(
      getBuildProgress({ streamStatus: 'ready', isRecovering: false, activeToolNames: [], inactiveForMs: 0 }),
    ).toBeNull();
  });
});
