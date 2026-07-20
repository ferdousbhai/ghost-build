// All Ghostbuild projects created after May 1 2025 dynamically import this script when they
// receive a postMessage of type 'ghostbuildPreviewRequest' in development.
import { toPng } from 'html-to-image';

export async function respondToMessage(message: MessageEvent) {
  // These checks should already have been made before loading this module.
  // Make them here again because they're really important.
  if (message.source !== window.parent) {
    return;
  }
  if (typeof message.data !== 'object' || message.data === null || message.data.type !== 'ghostbuildPreviewRequest') {
    return;
  }
  const requestId = typeof message.data.requestId === 'string' ? message.data.requestId : undefined;
  if (!requestId) {
    return;
  }
  if (message.data.request === 'ping') {
    message.source.postMessage({ type: 'pong', requestId }, message.origin);
  }
  if (message.data.request === 'screenshot') {
    try {
      const imageData = await toPng(document.body);
      message.source.postMessage({ type: 'screenshot', requestId, data: imageData }, message.origin);
    } catch (error) {
      message.source.postMessage(
        {
          type: 'ghostbuildPreviewError',
          requestId,
          message: error instanceof Error ? error.message : 'Failed to capture preview',
        },
        message.origin,
      );
    }
  }
}
