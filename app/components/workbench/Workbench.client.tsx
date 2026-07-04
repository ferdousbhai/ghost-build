import { useStore } from '@nanostores/react';
import { motion, type HTMLMotionProps, type Variants } from 'framer-motion';
import { lazy, memo, Suspense, useCallback, useEffect, useState, type ReactElement } from 'react';
import { toast } from 'sonner';
import {
  type OnChangeCallback as OnEditorChange,
  type OnScrollCallback as OnEditorScroll,
  type OnWheelCallback as OnEditorWheel,
} from '~/components/editor/codemirror/CodeMirrorEditor';
import { IconButton } from '~/components/ui/IconButton';
import { PanelHeaderButton } from '~/components/ui/PanelHeaderButton';
import { Slider, type SliderOptions } from '~/components/ui/Slider';
import { workbenchStore, type WorkbenchViewType } from '~/lib/stores/workbench.client';
import { classNames } from '~/utils/classNames';
import { cubicEasingFn } from '~/utils/easings';
import { createScopedLogger, renderLogger } from 'ghostbuild-agent/utils/logger';
import { EditorPanel } from './EditorPanel';
import useViewport from '~/lib/hooks/useViewport';
import { BackupStatusIndicator } from '~/components/BackupStatusIndicator';
import type { TerminalInitializationOptions } from '~/types/terminal';
import { getAbsolutePath } from 'ghostbuild-agent/utils/workDir';
import { PlusIcon, Cross2Icon } from '@radix-ui/react-icons';
import { CommandLineIcon } from '@heroicons/react/24/outline';

interface WorkbenchProps {
  chatStarted?: boolean;
  isStreaming?: boolean;
  terminalInitializationOptions?: TerminalInitializationOptions;
}

const viewTransition = { ease: cubicEasingFn };
const logger = createScopedLogger('Workbench');
const PreviewPaneGroup = lazy(() =>
  import('./PreviewPaneGroup').then((module) => ({ default: module.PreviewPaneGroup })),
);
const sliderOptions: SliderOptions<WorkbenchViewType> = {
  options: [
    {
      value: 'code',
      text: 'Code',
    },
    {
      value: 'preview',
      text: 'Preview',
    },
  ],
};

const workbenchVariants = {
  closed: {
    width: 0,
    transition: {
      duration: 0.2,
      ease: cubicEasingFn,
    },
  },
  open: {
    width: 'var(--workbench-width)',
    transition: {
      duration: 0.2,
      ease: cubicEasingFn,
    },
  },
} satisfies Variants;

export const Workbench = memo(function Workbench({
  chatStarted,
  isStreaming,
  terminalInitializationOptions,
}: WorkbenchProps) {
  renderLogger.trace('Workbench');

  const previews = useStore(workbenchStore.previews);
  const hasPreview = previews.length > 0;
  const showWorkbench = useStore(workbenchStore.showWorkbench);
  const selectedFile = useStore(workbenchStore.selectedFile);
  const currentDocument = useStore(workbenchStore.currentDocument);
  const unsavedFiles = useStore(workbenchStore.unsavedFiles);
  const files = useStore(workbenchStore.files);
  const selectedView = useStore(workbenchStore.currentView);

  const following = useStore(workbenchStore.followingStreamedCode);

  const isSmallViewport = useViewport(1024);

  const [previewPanes, setPreviewPanes] = useState<string[]>(() => [randomId()]);
  const [hasLoadedPreview, setHasLoadedPreview] = useState(false);

  const setSelectedView = (view: WorkbenchViewType) => {
    workbenchStore.currentView.set(view);
  };

  useEffect(() => {
    if (hasPreview) {
      workbenchStore.currentView.set('preview');
    }
  }, [hasPreview]);

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
      // This is called debounced, so it's not fair to use it to update
      // the current doc: we don't actually know which files it's for!

      const updateAbsPath = getAbsolutePath(update.filePath);
      if (currentDocumentPath !== updateAbsPath) {
        logger.debug(
          `onEditorChange fired for what is no longer the current document, changed: ${updateAbsPath} current: ${currentDocumentPath}`,
        );
        return;
      }

      workbenchStore.setCurrentDocumentContent(update.content);
    },
    [currentDocumentPath],
  );

  const onEditorScroll = useCallback<OnEditorScroll>((position) => {
    workbenchStore.setCurrentDocumentScrollPosition(position);
  }, []);

  const onEditorWheel = useCallback<OnEditorWheel>(() => {
    workbenchStore.stopFollowingStreamedCode();
  }, []);

  const onFileSelect = useCallback((filePath: string | undefined) => {
    workbenchStore.followingStreamedCode.set(false);
    const absPath = filePath ? getAbsolutePath(filePath) : undefined;
    workbenchStore.setSelectedFile(absPath);
  }, []);

  const onFileSave = useCallback(() => {
    workbenchStore.saveCurrentDocument().catch((err) => {
      logger.error('Failed to update file content', err);
      toast.error('Failed to update file content');
    });
  }, []);

  const onFileReset = useCallback(() => {
    workbenchStore.resetCurrentDocument();
  }, []);

  return (
    chatStarted && (
      <motion.div
        initial="closed"
        animate={showWorkbench ? 'open' : 'closed'}
        variants={workbenchVariants}
        className="z-workbench"
      >
        <div
          className={classNames(
            'fixed top-[calc(var(--header-height)+1rem)] bottom-four w-[var(--workbench-inner-width)] z-0 transition-[left,width] duration-200 bolt-ease-cubic-bezier',
            {
              'w-full': isSmallViewport,
              'left-0': showWorkbench && isSmallViewport,
              'left-[var(--workbench-left)]': showWorkbench && !isSmallViewport,
              'left-[100%]': !showWorkbench,
            },
          )}
        >
          <div className="absolute inset-0 px-2 lg:px-6">
            <div className="flex h-full flex-col overflow-hidden rounded-lg border bg-bolt-elements-background-depth-2 shadow">
              <div className="flex items-center border-b px-3 py-2">
                <Slider selected={selectedView} options={sliderOptions} setSelected={setSelectedView} />
                <div className="ml-auto" />
                {selectedView === 'code' && (
                  <div className="flex overflow-y-auto">
                    <BackupStatusIndicator />
                    <div className="w-4" />
                    <PanelHeaderButton
                      className="mr-1 text-sm"
                      onClick={() => {
                        workbenchStore.toggleTerminal(!workbenchStore.showTerminal.get());
                      }}
                    >
                      <CommandLineIcon className="size-4" />
                      Toggle Terminal
                    </PanelHeaderButton>
                  </div>
                )}
                {selectedView === 'preview' && (
                  <PanelHeaderButton
                    className="mr-1 text-sm"
                    onClick={() => {
                      setPreviewPanes([...previewPanes, randomId()]);
                    }}
                  >
                    <PlusIcon />
                    Add Preview
                  </PanelHeaderButton>
                )}
                <IconButton
                  icon={<Cross2Icon />}
                  className="-mr-1"
                  size="xl"
                  onClick={() => {
                    workbenchStore.showWorkbench.set(false);
                  }}
                />
              </div>
              <div className="relative flex-1 overflow-hidden">
                <View {...slidingPosition({ view: 'code', selectedView })}>
                  <EditorPanel
                    editorDocument={currentDocument}
                    isStreaming={isStreaming}
                    scrollToDocAppend={following && isStreaming}
                    selectedFile={selectedFile}
                    files={files}
                    unsavedFiles={unsavedFiles}
                    onFileSelect={onFileSelect}
                    onEditorScroll={onEditorScroll}
                    onEditorWheel={onEditorWheel}
                    onEditorChange={onEditorChange}
                    onFileSave={onFileSave}
                    onFileReset={onFileReset}
                    terminalInitializationOptions={terminalInitializationOptions}
                  />
                </View>
                <View {...slidingPosition({ view: 'preview', selectedView })}>
                  {hasLoadedPreview ? (
                    <Suspense fallback={null}>
                      <PreviewPaneGroup previewPanes={previewPanes} setPreviewPanes={setPreviewPanes} />
                    </Suspense>
                  ) : (
                    <div />
                  )}
                </View>
              </div>
            </div>
          </div>
        </div>
      </motion.div>
    )
  );
});

// View component for rendering content with motion transitions
interface ViewProps extends HTMLMotionProps<'div'> {
  children: ReactElement;
}

const View = memo(function View({ children, ...props }: ViewProps) {
  return (
    <motion.div className="absolute inset-0" transition={viewTransition} {...props}>
      {children}
    </motion.div>
  );
});

function slidingPosition({ view, selectedView }: { view: WorkbenchViewType; selectedView: WorkbenchViewType }) {
  const tabsInOrder: WorkbenchViewType[] = ['code', 'preview'];

  const viewIndex = tabsInOrder.indexOf(view);
  const selectedViewIndex = tabsInOrder.indexOf(selectedView);

  const position = { x: `${(viewIndex - selectedViewIndex) * 100}%` };

  return {
    initial: position,
    animate: position,
  } satisfies Partial<ViewProps>;
}

function randomId() {
  return Math.random().toString(36).substring(2, 15);
}
