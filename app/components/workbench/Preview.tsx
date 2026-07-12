import { useStore } from '@nanostores/react';
import * as Dialog from '@radix-ui/react-dialog';
import { ExternalLinkIcon, ImageIcon, MobileIcon, UpdateIcon } from '@radix-ui/react-icons';
import { memo, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Spinner } from '@ui/Spinner';
import { IconButton } from '~/components/ui/IconButton';
import { ContainerBootState, useContainerBootState } from '~/lib/stores/containerBootState';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { classNames } from '~/utils/classNames';
import { PortDropdown } from './PortDropdown';
import { ThumbnailChooser } from './ThumbnailChooser';
import { useDevicePreviewResize, type ResizeHandleSide } from './useDevicePreviewResize';
import { usePreviewNavigation } from './usePreviewNavigation';

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
        <div className="z-iframe-overlay absolute size-full" onClick={() => navigation.setIsPortDropdownOpen(false)} />
      )}
      <div className="flex items-center gap-2 bg-bolt-elements-background-depth-2 p-2">
        <IconButton icon={<UpdateIcon />} title="Reload preview" onClick={navigation.reload} />
        <div className="flex grow items-center gap-1 rounded-full border bg-bolt-elements-preview-addressBar-background px-3 py-1 text-sm text-bolt-elements-preview-addressBar-text hover:bg-bolt-elements-preview-addressBar-backgroundHover focus-within:border-border-selected focus-within:bg-bolt-elements-preview-addressBar-backgroundActive focus-within:text-bolt-elements-preview-addressBar-textActive hover:focus-within:bg-bolt-elements-preview-addressBar-backgroundActive">
          <input
            title="URL"
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
          <Dialog.Root open={isThumbnailModalOpen} onOpenChange={setIsThumbnailModalOpen}>
            <Dialog.Trigger asChild>
              <IconButton icon={<ImageIcon />} title="View Preview Image" />
            </Dialog.Trigger>
            <ThumbnailChooser
              isOpen={isThumbnailModalOpen}
              onOpenChange={setIsThumbnailModalOpen}
              onRequestCapture={navigation.requestScreenshot}
            />
          </Dialog.Root>
          <IconButton
            icon={<MobileIcon />}
            onClick={device.toggleDeviceMode}
            title={device.isDeviceModeOn ? 'Switch to Responsive Mode' : 'Switch to Device Mode'}
          />
          <IconButton
            icon={<ExternalLinkIcon />}
            onClick={() => void navigation.openInNewWindow()}
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
              <ResizeHandle side="left" onMouseDown={device.startResizing} />
              <ResizeHandle side="right" onMouseDown={device.startResizing} />
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
  onMouseDown,
}: {
  side: ResizeHandleSide;
  onMouseDown: (event: ReactMouseEvent, side: ResizeHandleSide) => void;
}) {
  return (
    <div
      onMouseDown={(event) => onMouseDown(event, side)}
      className={classNames(
        'absolute top-0 flex h-full w-[15px] cursor-ew-resize select-none items-center justify-center bg-white/20 transition-colors hover:bg-white/50',
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
