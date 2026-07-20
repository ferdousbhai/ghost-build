import { ExclamationTriangleIcon } from '@radix-ui/react-icons';
import type { Experience } from '~/utils/experienceChooser';
import { Button } from '@ui/Button';

type UnsupportedRuntimeProps = {
  experience?: Experience;
  framed?: boolean;
};

export function UnsupportedRuntimeScreen({ experience }: UnsupportedRuntimeProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="max-w-xl">
        <UnsupportedRuntimeNotice experience={experience} />
      </div>
    </div>
  );
}

export function UnsupportedRuntimeNotice({ experience, framed = true }: UnsupportedRuntimeProps) {
  const copy = getUnsupportedRuntimeCopy(experience);

  return (
    <div
      className={
        framed
          ? 'border-bolt-elements-borderColor text-content-primary flex flex-col gap-3 rounded-lg border bg-bolt-elements-background-depth-2 p-4 text-left shadow-sm'
          : 'text-content-primary flex flex-col gap-3 text-left'
      }
    >
      <div className="flex items-start gap-3">
        <ExclamationTriangleIcon className="text-content-warning mt-0.5 size-5 shrink-0" />
        <div className="min-w-0">
          <h2 className="font-display text-lg font-bold leading-tight">{copy.title}</h2>
          <p className="text-content-secondary mt-1 text-sm leading-6">{copy.body}</p>
        </div>
      </div>
    </div>
  );
}

export function WorkspaceSetupErrorScreen() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="max-w-xl">
        <WorkspaceSetupErrorNotice />
      </div>
    </div>
  );
}

export function WorkspaceSetupErrorNotice({ framed = true }: Pick<UnsupportedRuntimeProps, 'framed'>) {
  return (
    <div
      className={
        framed
          ? 'border-bolt-elements-borderColor text-content-primary flex flex-col gap-3 rounded-lg border bg-bolt-elements-background-depth-2 p-4 text-left shadow-sm'
          : 'text-content-primary flex flex-col gap-3 text-left'
      }
      role="alert"
    >
      <div className="flex items-start gap-3">
        <ExclamationTriangleIcon className="text-content-warning mt-0.5 size-5 shrink-0" />
        <div className="min-w-0">
          <h2 className="font-display text-lg font-bold leading-tight">Workspace setup stopped</h2>
          <p className="text-content-secondary mt-1 text-sm leading-6">
            Ghostbuild could not finish preparing the browser workspace. Your prompt is safe; reload to try again.
          </p>
        </div>
      </div>
      <div className="pl-8">
        <Button type="button" variant="neutral" size="sm" onClick={() => window.location.reload()}>
          Reload workspace
        </Button>
      </div>
    </div>
  );
}

function getUnsupportedRuntimeCopy(experience: Experience | undefined) {
  if (experience === 'marketing-page-only-for-desktop-safari') {
    return {
      title: 'Open Ghostbuild in Chrome or Edge',
      body: 'Safari cannot run the live app builder yet, so this project cannot finish loading here.',
    };
  }

  if (experience === 'marketing-page-only-for-mobile') {
    return {
      title: 'Use a desktop browser to build',
      body: 'The live builder needs a desktop version of Chrome or Edge.',
    };
  }

  return {
    title: 'Open Ghostbuild in Chrome or Edge',
    body: 'This browser cannot run the live app builder right now.',
  };
}
