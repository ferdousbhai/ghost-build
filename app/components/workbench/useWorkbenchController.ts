import { useStore } from '@nanostores/react';
import { useCallback, useEffect, useState } from 'react';
import { getAbsolutePath } from 'ghostbuild-agent/utils/workDir';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { toast } from 'sonner';
import type {
  OnChangeCallback as OnEditorChange,
  OnScrollCallback as OnEditorScroll,
  OnWheelCallback as OnEditorWheel,
} from '~/components/editor/codemirror/CodeMirrorEditor';
import useViewport from '~/lib/hooks/useViewport';
import { workbenchStore, type WorkbenchViewType } from '~/lib/stores/workbench.client';

const logger = createScopedLogger('WorkbenchController');

export function useWorkbenchController(isStreaming?: boolean) {
  const previews = useStore(workbenchStore.previews);
  const showWorkbench = useStore(workbenchStore.showWorkbench);
  const selectedFile = useStore(workbenchStore.selectedFile);
  const currentDocument = useStore(workbenchStore.currentDocument);
  const unsavedFiles = useStore(workbenchStore.unsavedFiles);
  const files = useStore(workbenchStore.files);
  const selectedView = useStore(workbenchStore.currentView);
  const following = useStore(workbenchStore.followingStreamedCode);
  const isSmallViewport = useViewport(1024);
  const [hasLoadedPreview, setHasLoadedPreview] = useState(false);

  useEffect(() => {
    if (previews.length) {
      workbenchStore.currentView.set('preview');
    }
  }, [previews.length]);

  useEffect(() => {
    if (selectedView === 'preview') {
      setHasLoadedPreview(true);
    }
  }, [selectedView]);

  useEffect(() => {
    workbenchStore.setDocuments(files);
  }, [files]);

  const currentDocumentPath = currentDocument?.filePath;
  const onEditorChange = useCallback<OnEditorChange>(
    (update) => {
      const updatePath = getAbsolutePath(update.filePath);
      if (currentDocumentPath !== updatePath) {
        logger.debug(
          `Editor update ignored for stale document, changed: ${updatePath} current: ${currentDocumentPath}`,
        );
        return;
      }
      workbenchStore.setCurrentDocumentContent(update.content);
    },
    [currentDocumentPath],
  );

  const onEditorScroll = useCallback<OnEditorScroll>(
    (position) => workbenchStore.setCurrentDocumentScrollPosition(position),
    [],
  );
  const onEditorWheel = useCallback<OnEditorWheel>(() => workbenchStore.stopFollowingStreamedCode(), []);
  const onFileSelect = useCallback((filePath: string | undefined) => {
    workbenchStore.followingStreamedCode.set(false);
    workbenchStore.setSelectedFile(filePath ? getAbsolutePath(filePath) : undefined);
  }, []);
  const onFileSave = useCallback(() => {
    void workbenchStore.saveCurrentDocument().catch((error) => {
      logger.error('Failed to update file content', error);
      toast.error('Failed to update file content');
    });
  }, []);

  return {
    close: () => workbenchStore.showWorkbench.set(false),
    currentDocument,
    files,
    following,
    hasLoadedPreview,
    isSmallViewport,
    onEditorChange,
    onEditorScroll,
    onEditorWheel,
    onFileReset: () => workbenchStore.resetCurrentDocument(),
    onFileSave,
    onFileSelect,
    selectedFile,
    selectedView,
    setSelectedView: (view: WorkbenchViewType) => workbenchStore.currentView.set(view),
    showWorkbench,
    toggleTerminal: () => workbenchStore.toggleTerminal(!workbenchStore.showTerminal.get()),
    unsavedFiles,
    scrollToDocAppend: following && isStreaming,
  };
}
