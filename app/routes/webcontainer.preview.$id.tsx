import { createFileRoute, notFound } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { isWebContainerPreviewId, webContainerPreviewUrl } from '~/lib/webcontainer/preview-url';

const PREVIEW_CHANNEL = 'preview-updates';

export const Route = createFileRoute('/webcontainer/preview/$id')({
  beforeLoad: ({ params }) => {
    if (!isWebContainerPreviewId(params.id)) {
      throw notFound();
    }
  },
  head: () => ({
    meta: [{ title: 'Preview | Ghostbuild' }],
  }),
  component: WebContainerPreview,
});

function WebContainerPreview() {
  const { id: previewId } = Route.useParams();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const broadcastChannelRef = useRef<BroadcastChannel | null>(null);
  const previewUrl = webContainerPreviewUrl(previewId);

  useEffect(() => {
    // Initialize broadcast channel
    broadcastChannelRef.current = new BroadcastChannel(PREVIEW_CHANNEL);
    const channel = broadcastChannelRef.current;

    const refreshPreview = () => {
      if (!iframeRef.current) {
        return;
      }

      // Force a clean reload
      iframeRef.current.src = '';
      requestAnimationFrame(() => {
        if (iframeRef.current) {
          iframeRef.current.src = previewUrl;
        }
      });
    };

    const notifyPreviewReady = () => {
      channel.postMessage({
        type: 'preview-ready',
        previewId,
        url: previewUrl,
        timestamp: Date.now(),
      });
    };
    const notifyPreviewClosed = () => {
      channel.postMessage({ type: 'preview-closed', previewId });
    };

    // Listen for preview updates
    channel.onmessage = (event) => {
      if (
        event.data.previewId === previewId &&
        (event.data.type === 'refresh-preview' || event.data.type === 'file-change')
      ) {
        refreshPreview();
      }
    };

    // Set the iframe src
    if (iframeRef.current) {
      iframeRef.current.src = previewUrl;
    }

    // Notify other tabs that this preview is ready
    notifyPreviewReady();
    window.addEventListener('pagehide', notifyPreviewClosed, { once: true });

    // Cleanup
    return () => {
      window.removeEventListener('pagehide', notifyPreviewClosed);
      channel.close();
      broadcastChannelRef.current = null;
    };
  }, [previewId, previewUrl]);

  return (
    <div className="size-full">
      <iframe
        ref={iframeRef}
        title="WebContainer Preview"
        className="size-full border-none"
        sandbox="allow-downloads allow-forms allow-modals allow-orientation-lock allow-pointer-lock allow-popups allow-popups-to-escape-sandbox allow-presentation allow-same-origin allow-scripts"
        allow="accelerometer; ambient-light-sensor; autoplay; bluetooth; camera; clipboard-write; compute-pressure; display-capture; fullscreen; gamepad; geolocation; gyroscope; hid; identity-credentials-get; idle-detection; local-fonts; magnetometer; microphone; midi; otp-credentials; payment; picture-in-picture; publickey-credentials-create; publickey-credentials-get; screen-wake-lock; serial; speaker-selection; usb; web-share; window-management; xr-spatial-tracking"
        allowFullScreen={true}
        loading="eager"
        onLoad={() => {
          broadcastChannelRef.current?.postMessage({
            type: 'preview-ready',
            previewId,
            url: previewUrl,
            timestamp: Date.now(),
          });
        }}
      />
    </div>
  );
}
