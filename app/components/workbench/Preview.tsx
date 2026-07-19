import { useStore } from '@nanostores/react';
import { ExternalLinkIcon, ImageIcon, MobileIcon, UpdateIcon } from '@radix-ui/react-icons';
import { memo, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { Spinner } from '@ui/Spinner';
import { IconButton } from '~/components/ui/IconButton';
import { ContainerBootState, useContainerBootState } from '~/lib/stores/containerBootState';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { classNames } from '~/utils/classNames';
import { PortDropdown } from './PortDropdown';
import { ThumbnailChooser } from './ThumbnailChooser';
import { useDevicePreviewResize, type ResizeHandleSide } from './useDevicePreviewResize';
import { usePreviewNavigation } from './usePreviewNavigation';
import { toast } from 'sonner';

export const Preview = memo(function Preview() {
  const previews = useStore(workbenchStore.previews);
  const navigation = usePreviewNavigation(previews);
  const device = useDevicePreviewResize();
  const containerBoot = useContainerBootState();
  const [isThumbnailModalOpen, setIsThumbnailModalOpen] = useState(false);
  const previewStartupMessage =
    containerBoot.state < ContainerBootState.READY ? 'Preparing preview...' : 'Starting preview...';

  return (
    <div className="relative flex size-full flex-col">
      {navigation.isPortDropdownOpen && (
        <div
          aria-hidden
          className="z-iframe-overlay absolute size-full"
          onClick={() => navigation.setIsPortDropdownOpen(false)}
        />
      )}
      <div className="flex items-center gap-2 bg-bolt-elements-background-depth-2 p-2">
        <IconButton
          icon={<UpdateIcon />}
          title="Reload preview"
          onClick={() => {
            void navigation.reload().catch((error) => {
              toast.error(error instanceof Error ? error.message : 'Unable to reload the preview.');
            });
          }}
        />
        <div className="flex grow items-center gap-1 rounded-full border bg-bolt-elements-preview-addressBar-background px-3 py-1 text-sm text-bolt-elements-preview-addressBar-text hover:bg-bolt-elements-preview-addressBar-backgroundHover focus-within:border-border-selected focus-within:bg-bolt-elements-preview-addressBar-backgroundActive focus-within:text-bolt-elements-preview-addressBar-textActive hover:focus-within:bg-bolt-elements-preview-addressBar-backgroundActive">
          <input
            title="URL"
            aria-label="Preview URL"
            ref={navigation.inputRef}
            className="w-full bg-transparent outline-none focus:outline-none"
            type="text"
            value={navigation.url || ''}
            onChange={(event) => navigation.setUrl(event.target.value)}
            onKeyDown={navigation.handleAddressKeyDown}
            disabled={navigation.previewBaseUrl === null}
          />
        </div>
        <div className="flex items-center gap-2">
          {previews.length > 1 && (
            <PortDropdown
              activePreviewIndex={navigation.activePreviewIndex}
              setActivePreviewIndex={navigation.setActivePreviewIndex}
              isDropdownOpen={navigation.isPortDropdownOpen}
              setHasSelectedPreview={navigation.markPreviewSelected}
              setIsDropdownOpen={navigation.setIsPortDropdownOpen}
              previews={previews}
            />
          )}
          <IconButton icon={<ImageIcon />} title="View Preview Image" onClick={() => setIsThumbnailModalOpen(true)} />
          <ThumbnailChooser
            isOpen={isThumbnailModalOpen}
            onOpenChange={setIsThumbnailModalOpen}
            onRequestCapture={navigation.requestScreenshot}
          />
          <IconButton
            icon={<MobileIcon />}
            aria-pressed={device.isDeviceModeOn}
            onClick={device.toggleDeviceMode}
            title={device.isDeviceModeOn ? 'Switch to Responsive Mode' : 'Switch to Device Mode'}
          />
          <IconButton
            icon={<ExternalLinkIcon />}
            onClick={() => {
              void navigation.openInNewWindow().catch((error) => {
                toast.error(error instanceof Error ? error.message : 'Unable to open the preview window.');
              });
            }}
            title="Open in New Window"
          />
        </div>
      </div>

      <div className="flex flex-1 items-center justify-center overflow-auto border-t">
        <div
          className="relative flex h-full bg-bolt-elements-background-depth-1"
          style={{ width: device.isDeviceModeOn ? `${device.widthPercent}%` : '100%', overflow: 'visible' }}
        >
          {navigation.activePreview ? (
            navigation.previewBaseUrl ? (
              <iframe
                ref={navigation.setIframeRef}
                title="preview"
                className="size-full border-none bg-bolt-elements-background-depth-1"
                src={navigation.iframeUrl}
                sandbox="allow-downloads allow-forms allow-modals allow-orientation-lock allow-pointer-lock allow-popups allow-popups-to-escape-sandbox allow-presentation allow-same-origin allow-scripts"
                allow="accelerometer; ambient-light-sensor; autoplay; bluetooth; camera; clipboard-write; compute-pressure; display-capture; fullscreen; gamepad; geolocation; gyroscope; hid; identity-credentials-get; idle-detection; local-fonts; magnetometer; microphone; midi; otp-credentials; payment; picture-in-picture; publickey-credentials-create; publickey-credentials-get; screen-wake-lock; serial; speaker-selection; usb; web-share; window-management; xr-spatial-tracking"
                allowFullScreen
              />
            ) : (
              <PreviewStatus>
                <Spinner />
              </PreviewStatus>
            )
          ) : (
            <PreviewStatus>{previewStartupMessage}</PreviewStatus>
          )}
          {device.isDeviceModeOn && (
            <>
              <ResizeHandle
                side="left"
                widthPercent={device.widthPercent}
                onMouseDown={device.startResizing}
                onKeyDown={device.adjustWidthWithKeyboard}
              />
              <ResizeHandle
                side="right"
                widthPercent={device.widthPercent}
                onMouseDown={device.startResizing}
                onKeyDown={device.adjustWidthWithKeyboard}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
});

function PreviewStatus({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex size-full items-center justify-center bg-bolt-elements-background-depth-1 text-content-primary">
      {children}
    </div>
  );
}

function ResizeHandle({
  side,
  widthPercent,
  onMouseDown,
  onKeyDown,
}: {
  side: ResizeHandleSide;
  widthPercent: number;
  onMouseDown: (event: ReactMouseEvent, side: ResizeHandleSide) => void;
  onKeyDown: (side: ResizeHandleSide, key: 'ArrowLeft' | 'ArrowRight') => void;
}) {
  return (
    <div
      role="separator"
      aria-label={`Resize preview from the ${side}`}
      aria-orientation="vertical"
      aria-valuemin={10}
      aria-valuemax={90}
      aria-valuenow={widthPercent}
      tabIndex={0}
      onMouseDown={(event) => onMouseDown(event, side)}
      onKeyDown={(event: ReactKeyboardEvent) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          onKeyDown(side, event.key);
        }
      }}
      className={classNames(
        'absolute top-0 flex h-full w-[15px] cursor-ew-resize select-none items-center justify-center bg-white/20 transition-colors hover:bg-white/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500',
        side === 'left' ? 'left-0 -ml-[15px]' : 'right-0 -mr-[15px]',
      )}
      title="Drag to resize width"
    >
      <div className="pointer-events-none flex h-full items-center justify-center">
        <div className="ml-px select-none text-[10px] leading-[5px] text-black/50">••• •••</div>
      </div>
    </div>
  );
}
