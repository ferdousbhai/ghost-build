import { WebContainer } from '@webcontainer/api';
import { WORK_DIR_NAME } from 'ghostbuild-agent/constants';
import { cleanStackTrace } from '~/utils/stacktrace';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import {
  setContainerBootState,
  setUnsupportedContainerBootState,
  ContainerBootState,
} from '~/lib/stores/containerBootState';
import { workbenchActionAlert } from '~/lib/stores/workbench-ui-state';
import { chooseExperience } from '~/utils/experienceChooser';

export let webcontainer: Promise<WebContainer> = new Promise(() => {
  // noop for ssr
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

if (shouldBootWebcontainer) {
  webcontainer =
    import.meta.hot?.data.webcontainer ??
    bootWebcontainer()
      .then((webcontainer) => {
        // Listen for preview errors
        webcontainer.on('preview-message', (message) => {
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
        // Set the container boot state to LOADING_SNAPSHOT to hand off control
        // to the container setup code.
        setContainerBootState(ContainerBootState.LOADING_SNAPSHOT);
        return webcontainer;
      })
      .catch((error) => {
        setContainerBootState(ContainerBootState.ERROR, error);
        throw error;
      });

  if (import.meta.hot) {
    import.meta.hot.data.webcontainer = webcontainer;
  }
}

function bootWebcontainer() {
  setContainerBootState(ContainerBootState.STARTING);
  return WebContainer.boot({
    coep: 'credentialless',
    workdirName: WORK_DIR_NAME,
    forwardPreviewErrors: true, // Enable error forwarding from iframes
  });
}
