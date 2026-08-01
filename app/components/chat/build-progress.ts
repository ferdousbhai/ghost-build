import type { StreamStatus } from '~/lib/common/types';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';

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
// Validation reports each bounded server stage. A stage that has not advanced
// within these windows is slow or stalled even though the full pipeline may be longer.
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
}): BuildProgressPhase {
  if (args.activeToolNames.includes('npmInstall')) {
    return 'installing';
  }
  if (args.activeToolNames.includes('validateProject')) {
    return 'validating';
  }
  if (args.activeToolNames.includes('deploy')) {
    return 'checking';
  }
  if (args.activeToolNames.some((name) => name === 'writeFile' || name === 'edit')) {
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
    case 'installing':
      return 'Installing dependencies…';
    case 'validating':
      return validationStageMessage(validationStage);
    case 'checking':
      return 'Checking that everything works…';
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
    case 'installing':
      return 'installing dependencies';
    case 'validating':
      return validationStageActivity(validationStage);
    case 'checking':
      return 'checking the preview';
    case 'recovering':
      return 'recovering the build';
  }
  return 'building your project';
}

function validationStageMessage(stage?: BuilderValidationStage | null): string {
  switch (stage) {
    case 'sandbox initialization':
      return 'Starting isolated validation…';
    case 'source extraction':
      return 'Loading your project for validation…';
    case 'workspace policy verification':
      return 'Checking project configuration…';
    case 'dependency installation':
      return 'Installing validation dependencies…';
    case 'worker type generation':
      return 'Generating Worker types…';
    case 'route generation':
      return 'Generating application routes…';
    case 'type checking':
      return 'Type-checking your project…';
    case 'stack verification':
      return 'Checking project compatibility…';
    case 'license verification':
      return 'Checking production licenses…';
    case 'application build':
      return 'Building your project for production…';
    case 'built output verification':
      return 'Checking the production build…';
    case 'linting':
      return 'Linting your project…';
    case 'security boundary verification':
      return 'Running final security checks…';
    case 'build packaging':
    case 'build download':
    case null:
    case undefined:
      return 'Validating your project…';
  }
  return 'Validating your project…';
}

function validationStageActivity(stage?: BuilderValidationStage | null): string {
  return validationStageMessage(stage).replace(/…$/, '').toLowerCase();
}
