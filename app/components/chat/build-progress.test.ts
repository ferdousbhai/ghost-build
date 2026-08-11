import { describe, expect, it } from 'vitest';
import {
  BUILD_PROGRESS_DELAY_MS,
  getBuildProgress,
  RECOVERY_PROGRESS_DELAY_MS,
  VALIDATION_PROGRESS_DELAY_MS,
} from './build-progress';

describe('getBuildProgress', () => {
  it('shows a meaningful phase instead of an unexplained loader', () => {
    expect(
      getBuildProgress({ streamStatus: 'submitted', isRecovering: false, activeToolNames: [], inactiveForMs: 0 }),
    ).toMatchObject({ phase: 'planning', message: 'Planning your project…', delayed: false });
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
    ).toMatchObject({ message: 'Still updating your project — no new update for 45s' });
  });

  it.each([
    ['write', 'saving', 'Saving changes…'],
    ['edit', 'saving', 'Saving changes…'],
    ['exec', 'running', 'Running command…'],
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

  it('reports quiet commands as running without guessing that they are stuck', () => {
    const delayed = getBuildProgress({
      streamStatus: 'streaming',
      isRecovering: false,
      activeToolNames: ['exec'],
      inactiveForMs: BUILD_PROGRESS_DELAY_MS,
    });
    const longer = getBuildProgress({
      streamStatus: 'streaming',
      isRecovering: false,
      activeToolNames: ['exec'],
      inactiveForMs: 90_000,
    });
    expect(delayed).toMatchObject({ delayed: true });
    expect(delayed?.message).toBe('Command is still running — no new output for 45s');
    expect(longer?.message).toBe('Command is still running — no new output for 1m 30s');
    expect(longer?.message).not.toMatch(/(?:maybe|stuck|request|tool|call)[-_ ]?id/i);
  });

  it('allows the isolated full validation contract more time than ordinary model activity', () => {
    expect(
      getBuildProgress({
        streamStatus: 'streaming',
        isRecovering: false,
        activeToolNames: ['write'],
        validationStage: 'computer validation',
        inactiveForMs: 90_000,
      }),
    ).toMatchObject({
      phase: 'validating',
      delayed: false,
      message: 'Validating your project with Cloudflare Computer…',
    });
    expect(
      getBuildProgress({
        streamStatus: 'streaming',
        isRecovering: false,
        activeToolNames: ['write'],
        validationStage: 'computer validation',
        inactiveForMs: VALIDATION_PROGRESS_DELAY_MS,
      }),
    ).toMatchObject({
      delayed: true,
      message: 'Still validating your project with cloudflare computer — no new update for 2m',
    });
    expect(
      getBuildProgress({
        streamStatus: 'streaming',
        isRecovering: false,
        activeToolNames: ['write'],
        validationStage: 'computer validation',
        inactiveForMs: 6 * 60_000,
      }),
    ).toMatchObject({
      delayed: true,
      message: 'Still validating your project with cloudflare computer — no new update for 6m',
    });
  });

  it('shows automatic Computer validation inside a primitive mutation', () => {
    expect(
      getBuildProgress({
        streamStatus: 'streaming',
        isRecovering: false,
        activeToolNames: ['write'],
        validationStage: 'computer validation',
        inactiveForMs: 0,
      }),
    ).toMatchObject({ phase: 'validating', message: 'Validating your project with Cloudflare Computer…' });
    expect(
      getBuildProgress({
        streamStatus: 'streaming',
        isRecovering: false,
        activeToolNames: ['write'],
        validationStage: 'computer validation',
        inactiveForMs: VALIDATION_PROGRESS_DELAY_MS,
      }),
    ).toMatchObject({
      delayed: true,
      message: 'Still validating your project with cloudflare computer — no new update for 2m',
    });
  });

  it('prioritizes active validation over an overlapping completed mutation', () => {
    expect(
      getBuildProgress({
        streamStatus: 'streaming',
        isRecovering: false,
        activeToolNames: ['write'],
        validationStage: 'computer validation',
        inactiveForMs: 90_000,
      }),
    ).toMatchObject({
      phase: 'validating',
      message: 'Validating your project with Cloudflare Computer…',
      delayed: false,
    });
  });

  it('shows recovered tool activity, then recovery while waiting, and nothing after the turn ends', () => {
    expect(
      getBuildProgress({
        streamStatus: 'submitted',
        isRecovering: true,
        activeToolNames: ['write'],
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
    ).toMatchObject({ delayed: true, message: 'Still recovering the build — no new update for 5m' });
    expect(
      getBuildProgress({
        streamStatus: 'submitted',
        isRecovering: true,
        activeToolNames: [],
        inactiveForMs: 30 * 60_000,
      }),
    ).toMatchObject({ delayed: true, message: 'Still recovering the build — no new update for 30m' });
    expect(
      getBuildProgress({ streamStatus: 'ready', isRecovering: false, activeToolNames: [], inactiveForMs: 0 }),
    ).toBeNull();
  });
});
