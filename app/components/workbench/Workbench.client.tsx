import { motion, type HTMLMotionProps, type Variants } from 'framer-motion';
import { lazy, memo, Suspense, type ReactElement } from 'react';
import { IconButton } from '~/components/ui/IconButton';
import { PanelHeaderButton } from '~/components/ui/PanelHeaderButton';
import { Slider, type SliderOptions } from '~/components/ui/Slider';
import type { WorkbenchViewType } from '~/lib/stores/workbench.client';
import { classNames } from '~/utils/classNames';
import { cubicEasingFn } from '~/utils/easings';
import { renderLogger } from 'ghostbuild-agent/utils/logger';
import { EditorPanel } from './EditorPanel';
import { BackupStatusIndicator } from '~/components/BackupStatusIndicator';
import type { TerminalInitializationOptions } from '~/types/terminal';
import { Cross2Icon } from '@radix-ui/react-icons';
import { CommandLineIcon } from '@heroicons/react/24/outline';
import { useWorkbenchController } from './useWorkbenchController';
import { useStore } from '@nanostores/react';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { activeTerminalTabStore } from '~/lib/stores/terminalTabs';

interface WorkbenchProps {
  chatStarted?: boolean;
  isStreaming?: boolean;
  terminalInitializationOptions?: TerminalInitializationOptions;
}

const viewTransition = { ease: cubicEasingFn };
const Preview = lazy(() => import('./Preview').then((module) => ({ default: module.Preview })));
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
  const controller = useWorkbenchController(isStreaming);
  const showTerminal = useStore(workbenchStore.showTerminal);

  return (
    chatStarted && (
      <motion.div
        initial="closed"
        animate={controller.showWorkbench ? 'open' : 'closed'}
        variants={workbenchVariants}
        className="z-workbench"
      >
        <div
          className={classNames(
            'fixed top-[calc(var(--header-height)+1rem)] bottom-four w-[var(--workbench-inner-width)] z-0 transition-[left,width] duration-200 bolt-ease-cubic-bezier',
            {
              'w-full': controller.isSmallViewport,
              'left-0': controller.showWorkbench && controller.isSmallViewport,
              'left-[var(--workbench-left)]': controller.showWorkbench && !controller.isSmallViewport,
              'left-[100%]': !controller.showWorkbench,
            },
          )}
        >
          <div className="absolute inset-0 px-2 lg:px-6">
            <div className="flex h-full flex-col overflow-hidden rounded-lg border bg-bolt-elements-background-depth-2 shadow">
              <div className="flex items-center border-b px-3 py-2">
                <Slider
                  selected={controller.selectedView}
                  options={sliderOptions}
                  setSelected={controller.setSelectedView}
                />
                <div className="ml-auto" />
                {controller.selectedView === 'code' && (
                  <div className="flex overflow-y-auto">
                    <BackupStatusIndicator />
                    <div className="w-4" />
                    <PanelHeaderButton
                      className="mr-1 text-sm"
                      onClick={() => {
                        if (!showTerminal) {
                          activeTerminalTabStore.set(2);
                        }
                        controller.toggleTerminal();
                      }}
                    >
                      <CommandLineIcon className="size-4" />
                      {showTerminal ? 'Hide shell' : 'Open shell'}
                    </PanelHeaderButton>
                  </div>
                )}
                <IconButton
                  icon={<Cross2Icon />}
                  className="-mr-1"
                  size="xl"
                  title="Close workbench"
                  onClick={controller.close}
                />
              </div>
              <div className="relative flex-1 overflow-hidden">
                <View {...slidingPosition({ view: 'code', selectedView: controller.selectedView })}>
                  <EditorPanel
                    editorDocument={controller.currentDocument}
                    isStreaming={isStreaming}
                    scrollToDocAppend={controller.scrollToDocAppend}
                    selectedFile={controller.selectedFile}
                    files={controller.files}
                    unsavedFiles={controller.unsavedFiles}
                    onFileSelect={controller.onFileSelect}
                    onEditorScroll={controller.onEditorScroll}
                    onEditorWheel={controller.onEditorWheel}
                    onEditorChange={controller.onEditorChange}
                    onFileSave={controller.onFileSave}
                    onFileReset={controller.onFileReset}
                    terminalInitializationOptions={terminalInitializationOptions}
                  />
                </View>
                <View {...slidingPosition({ view: 'preview', selectedView: controller.selectedView })}>
                  {controller.hasLoadedPreview ? (
                    <Suspense fallback={null}>
                      <Preview />
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
