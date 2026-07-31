import type { StreamStatus } from '~/lib/common/types';

export type BuildProgressPhase =
  'planning' | 'creating' | 'saving' | 'installing' | 'validating' | 'checking' | 'recovering';

export type BuildProgress = {
  phase: BuildProgressPhase;
  message: string;
  delayed: boolean;
  stalled: boolean;
};

export const BUILD_PROGRESS_DELAY_MS = 45_000;
export const BUILD_PROGRESS_STALL_MS = 90_000;
export const VALIDATION_PROGRESS_DELAY_MS = 2 * 60_000;
export const VALIDATION_PROGRESS_STALL_MS = 8 * 60_000;
export const RECOVERY_PROGRESS_DELAY_MS = 5 * 60_000;
export const RECOVERY_PROGRESS_STALL_MS = 30 * 60_000;

export function getBuildProgress(args: {
  streamStatus: StreamStatus;
  isRecovering: boolean;
  activeToolNames: string[];
  inactiveForMs: number;
}): BuildProgress | null {
  if (args.streamStatus !== 'submitted' && args.streamStatus !== 'streaming' && !args.isRecovering) {
    return null;
  }

  const phase = buildPhase(args);
  const delayMs =
    phase === 'validating'
      ? VALIDATION_PROGRESS_DELAY_MS
      : phase === 'recovering'
        ? RECOVERY_PROGRESS_DELAY_MS
        : BUILD_PROGRESS_DELAY_MS;
  const stallMs =
    phase === 'validating'
      ? VALIDATION_PROGRESS_STALL_MS
      : phase === 'recovering'
        ? RECOVERY_PROGRESS_STALL_MS
        : BUILD_PROGRESS_STALL_MS;
  const delayed = args.inactiveForMs >= delayMs;
  const stalled = args.inactiveForMs >= stallMs;
  const normalMessage = phaseMessage(phase);
  const activity = activityLabel(phase);

  return {
    phase,
    delayed,
    stalled,
    message: stalled
      ? `This may be stuck — last progress: ${activity}`
      : delayed
        ? `Taking longer than usual — still ${activity}`
        : normalMessage,
  };
}

function buildPhase(args: {
  streamStatus: StreamStatus;
  isRecovering: boolean;
  activeToolNames: string[];
}): BuildProgressPhase {
  if (args.activeToolNames.includes('npmInstall')) {
    return 'installing';
  }
  if (args.activeToolNames.some((name) => name === 'writeFile' || name === 'edit')) {
    return 'saving';
  }
  if (args.activeToolNames.includes('validateProject')) {
    return 'validating';
  }
  if (args.activeToolNames.includes('deploy')) {
    return 'checking';
  }
  if (args.isRecovering) {
    return 'recovering';
  }
  return args.streamStatus === 'submitted' ? 'planning' : 'creating';
}

function phaseMessage(phase: BuildProgressPhase): string {
  switch (phase) {
    case 'planning':
      return 'Planning your project…';
    case 'creating':
      return 'Creating your project…';
    case 'saving':
      return 'Saving changes…';
    case 'installing':
      return 'Installing dependencies…';
    case 'validating':
      return 'Validating your project…';
    case 'checking':
      return 'Checking that everything works…';
    case 'recovering':
      return 'Recovering the interrupted build…';
  }
  return 'Building your project…';
}

function activityLabel(phase: BuildProgressPhase): string {
  switch (phase) {
    case 'planning':
      return 'planning your project';
    case 'creating':
      return 'creating your project';
    case 'saving':
      return 'saving changes';
    case 'installing':
      return 'installing dependencies';
    case 'validating':
      return 'validating your project';
    case 'checking':
      return 'checking the preview';
    case 'recovering':
      return 'recovering the build';
  }
  return 'building your project';
}
