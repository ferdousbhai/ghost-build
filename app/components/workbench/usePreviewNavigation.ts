import { reloadPreview as reloadWebContainerPreview } from '@webcontainer/api';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import type { PreviewInfo } from '~/lib/stores/previews';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { captureMessage } from '~/lib/telemetry.client';
import { webContainerPreviewIdFromUrl } from '~/lib/webcontainer/preview-url';

const logger = createScopedLogger('PreviewNavigation');

export function usePreviewNavigation(previews: PreviewInfo[]) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const userSelectedPreview = useRef(false);
  const selectedPreviewPort = useRef<number | null>(null);
  const [activePreviewIndex, setActivePreviewIndex] = useState(0);
  const [isPortDropdownOpen, setIsPortDropdownOpen] = useState(false);
  const [url, setUrl] = useState<string>();
  const [iframeUrl, setIframeUrl] = useState<string>();
  const activePreview = previews[activePreviewIndex];
  const activePreviewPort = activePreview?.port;
  const previewBaseUrl = activePreview?.ready ? activePreview.baseUrl : null;

  useEffect(() => {
    if (!previewBaseUrl) {
      setUrl(undefined);
      setIframeUrl(undefined);
      return;
    }
    setUrl('/');
    if (previewBaseUrl.endsWith('/')) {
      captureMessage('Preview base URL unexpectedly had a trailing slash');
    }
    setIframeUrl(`${previewBaseUrl}/`);
  }, [previewBaseUrl]);

  useEffect(() => {
    if (previews.length === 0) {
      setActivePreviewIndex(0);
      return;
    }
    if (userSelectedPreview.current && selectedPreviewPort.current !== null) {
      const selectedIndex = previews.findIndex((preview) => preview.port === selectedPreviewPort.current);
      if (selectedIndex !== -1) {
        setActivePreviewIndex(selectedIndex);
        return;
      }
      userSelectedPreview.current = false;
      selectedPreviewPort.current = null;
    }

    setActivePreviewIndex(
      previews.reduce(
        (minimumIndex, preview, index) => (preview.port < previews[minimumIndex].port ? index : minimumIndex),
        0,
      ),
    );
  }, [previews]);

  const reload = useCallback(async () => {
    if (iframeRef.current) {
      await reloadWebContainerPreview(iframeRef.current);
    }
  }, []);

  const handleAddressKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== 'Enter') {
        return;
      }
      if (previewBaseUrl === null) {
        captureMessage('Preview key event arrived before base URL');
        return;
      }
      if (iframeUrl === undefined) {
        captureMessage('Preview key event arrived before iframe URL');
        return;
      }
      if (url?.startsWith('http://') || url?.startsWith('https://')) {
        setUrl(iframeUrl.slice(previewBaseUrl.length));
        inputRef.current?.blur();
        return;
      }
      const nextUrl = url?.startsWith('/') ? url : `/${url ?? ''}`;
      setUrl(nextUrl);
      setIframeUrl(previewBaseUrl + nextUrl);
      inputRef.current?.blur();
    },
    [iframeUrl, previewBaseUrl, url],
  );

  const openInNewWindow = useCallback(async () => {
    if (!activePreview) {
      throw new Error('Preview not loaded');
    }
    const { proxyPort, proxyUrl } = await workbenchStore.startProxy(activePreview.port);
    const previewId = webContainerPreviewIdFromUrl(proxyUrl);
    if (!previewId) {
      logger.warn('Invalid WebContainer URL:', proxyUrl);
      workbenchStore.stopProxy(proxyPort);
      return;
    }
    const newWindow = window.open(
      `/webcontainer/preview/${previewId}`,
      '_blank',
      'noopener,noreferrer,menubar=no,toolbar=no,location=no,status=no',
    );
    if (!newWindow) {
      workbenchStore.stopProxy(proxyPort);
      throw new Error('The browser blocked the preview window');
    }
    workbenchStore.trackExternalPreview(proxyPort, previewId);
    newWindow.focus();
  }, [activePreview]);

  const setIframeRef = useCallback(
    (node: HTMLIFrameElement | null) => {
      iframeRef.current = node;
      if (activePreviewPort !== undefined) {
        workbenchStore.setPreviewIframe(activePreviewPort, node);
      }
    },
    [activePreviewPort],
  );

  const selectPreviewIndex = useCallback(
    (index: number) => {
      selectedPreviewPort.current = previews[index]?.port ?? null;
      setActivePreviewIndex(index);
    },
    [previews],
  );

  return {
    activePreview,
    activePreviewIndex,
    handleAddressKeyDown,
    iframeUrl,
    inputRef,
    isPortDropdownOpen,
    markPreviewSelected: (selected: boolean) => {
      userSelectedPreview.current = selected;
      if (!selected) {
        selectedPreviewPort.current = null;
      }
    },
    openInNewWindow,
    previewBaseUrl,
    reload,
    requestScreenshot: () => workbenchStore.requestScreenshot(activePreviewIndex),
    setActivePreviewIndex: selectPreviewIndex,
    setIframeRef,
    setIsPortDropdownOpen,
    setUrl,
    url,
  };
}
