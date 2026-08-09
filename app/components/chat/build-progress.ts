import type { StreamStatus } from '~/lib/common/types';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';

export type BuildProgressPhase = 'planning' | 'creating' | 'saving' | 'validating' | 'recovering';

export type BuildProgress = {
  phase: BuildProgressPhase;
  message: string;
  delayed: boolean;
  stalled: boolean;
};

export const BUILD_PROGRESS_DELAY_MS = 45_000;
export const BUILD_PROGRESS_STALL_MS = 90_000;
// Validation is one bounded Computer operation, so these windows cover the full pipeline.
export const VALIDATION_PROGRESS_DELAY_MS = 2 * 60_000;
export const VALIDATION_PROGRESS_STALL_MS = 6 * 60_000;
export const RECOVERY_PROGRESS_DELAY_MS = 5 * 60_000;
export const RECOVERY_PROGRESS_STALL_MS = 30 * 60_000;

export function getBuildProgress(args: {
  streamStatus: StreamStatus;
  isRecovering: boolean;
  isProjectUpdate?: boolean;
  activeToolNames: string[];
  validationStage?: BuilderValidationStage | null;
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
  const normalMessage = phaseMessage(phase, args.isProjectUpdate === true, args.validationStage);
  const activity = activityLabel(phase, args.isProjectUpdate === true, args.validationStage);

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
  validationStage?: BuilderValidationStage | null;
}): BuildProgressPhase {
  if (args.validationStage) {
    return 'validating';
  }
  if (args.activeToolNames.some((name) => name === 'write' || name === 'edit' || name === 'exec')) {
    return 'saving';
  }
  if (args.isRecovering) {
    return 'recovering';
  }
  return args.streamStatus === 'submitted' ? 'planning' : 'creating';
}

function phaseMessage(
  phase: BuildProgressPhase,
  isProjectUpdate: boolean,
  validationStage?: BuilderValidationStage | null,
): string {
  switch (phase) {
    case 'planning':
      return isProjectUpdate ? 'Planning your changes…' : 'Planning your project…';
    case 'creating':
      return isProjectUpdate ? 'Updating your project…' : 'Creating your project…';
    case 'saving':
      return 'Saving changes…';
    case 'validating':
      return validationStageMessage(validationStage);
    case 'recovering':
      return 'Recovering the interrupted build…';
  }
  return 'Building your project…';
}

function activityLabel(
  phase: BuildProgressPhase,
  isProjectUpdate: boolean,
  validationStage?: BuilderValidationStage | null,
): string {
  switch (phase) {
    case 'planning':
      return isProjectUpdate ? 'planning your changes' : 'planning your project';
    case 'creating':
      return isProjectUpdate ? 'updating your project' : 'creating your project';
    case 'saving':
      return 'saving changes';
    case 'validating':
      return validationStageActivity(validationStage);
    case 'recovering':
      return 'recovering the build';
  }
  return 'building your project';
}

function validationStageMessage(stage?: BuilderValidationStage | null): string {
  return stage === 'computer validation'
    ? 'Validating your project with Cloudflare Computer…'
    : 'Validating your project…';
}

function validationStageActivity(stage?: BuilderValidationStage | null): string {
  return validationStageMessage(stage).replace(/…$/, '').toLowerCase();
}
