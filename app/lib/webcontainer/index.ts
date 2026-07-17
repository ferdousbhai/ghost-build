import { WebContainer } from '@webcontainer/api';
import { WORK_DIR_NAME } from 'ghostbuild-agent/constants';
import { cleanStackTrace } from '~/utils/stacktrace';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import {
  setContainerBootState,
  getContainerBootState,
  setUnsupportedContainerBootState,
  ContainerBootState,
} from '~/lib/stores/containerBootState';
import { workbenchActionAlert } from '~/lib/stores/workbench-ui-state';
import { chooseExperience } from '~/utils/experienceChooser';

let resolveWebcontainer: (container: WebContainer) => void = () => undefined;
let rejectWebcontainer: (error: unknown) => void = () => undefined;

// Stores import this promise during module initialization. Keep its identity
// stable, then resolve it only when a chat surface explicitly starts the
// browser runtime. This prevents the homepage's first-message handoff from
// competing with WebContainer boot before the Cloudflare Agent request starts.
export const webcontainer: Promise<WebContainer> = new Promise((resolve, reject) => {
  resolveWebcontainer = resolve;
  rejectWebcontainer = reject;
});

const logger = createScopedLogger('webcontainer');

let shouldBootWebcontainer = false;
if (!import.meta.env.SSR) {
  const experience = chooseExperience(navigator.userAgent, window.crossOriginIsolated);

  shouldBootWebcontainer = experience === 'the-real-thing' || experience === 'mobile-warning';
  if (!shouldBootWebcontainer) {
    logger.warn(`Not attempting to boot webcontainer for experience: ${experience}`);
    setUnsupportedContainerBootState(experience);
  }
}

let webcontainerBootStarted = false;

export function startWebcontainer(): Promise<WebContainer> {
  if (!shouldBootWebcontainer || webcontainerBootStarted) {
    return webcontainer;
  }
  webcontainerBootStarted = true;
  const boot: Promise<WebContainer> = import.meta.hot?.data.webcontainer ?? bootWebcontainer();
  if (import.meta.hot) {
    import.meta.hot.data.webcontainer = boot;
  }
  void boot
    .then((container) => {
      // Listen for preview errors
      container.on('preview-message', (message) => {
        logger.info('WebContainer preview message:', JSON.stringify(message));

        // Handle both uncaught exceptions and unhandled promise rejections
        if (message.type === 'PREVIEW_UNCAUGHT_EXCEPTION' || message.type === 'PREVIEW_UNHANDLED_REJECTION') {
          const isPromise = message.type === 'PREVIEW_UNHANDLED_REJECTION';
          workbenchActionAlert.set({
            type: 'preview',
            title: isPromise ? 'Unhandled Promise Rejection' : 'Uncaught Exception',
            description: message.message,
            content: `Error occurred at ${message.pathname}${message.search}${message.hash}\nPort: ${message.port}\n\nStack trace:\n${cleanStackTrace(message.stack || '')}`,
            source: 'preview',
          });
        }
      });
      // A timed-out boot may finish later. Keep the actionable error state
      // instead of returning the UI to an endless loading sequence.
      if (getContainerBootState().state !== ContainerBootState.ERROR) {
        setContainerBootState(ContainerBootState.LOADING_SNAPSHOT);
      }
      resolveWebcontainer(container);
    })
    .catch((error: unknown) => {
      const bootError = error instanceof Error ? error : new Error(String(error));
      setContainerBootState(ContainerBootState.ERROR, bootError);
      rejectWebcontainer(error);
    });
  return webcontainer;
}

function bootWebcontainer() {
  setContainerBootState(ContainerBootState.STARTING);
  return WebContainer.boot({
    coep: 'credentialless',
    workdirName: WORK_DIR_NAME,
    forwardPreviewErrors: true, // Enable error forwarding from iframes
  });
}
