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
import { getWorkbenchInteraction } from './workbench-interaction';
import useViewport from '~/lib/hooks/useViewport';

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
  const showWorkbench = useStore(workbenchStore.showWorkbench);

  if (!chatStarted) {
    return null;
  }

  if (isStreaming || !showWorkbench) {
    return <StreamingWorkbench showWorkbench={showWorkbench} />;
  }

  return <ReadyWorkbench terminalInitializationOptions={terminalInitializationOptions} />;
});

function ReadyWorkbench({ terminalInitializationOptions }: Pick<WorkbenchProps, 'terminalInitializationOptions'>) {
  const controller = useWorkbenchController(false);
  const showTerminal = useStore(workbenchStore.showTerminal);
  const interaction = getWorkbenchInteraction({ visible: controller.showWorkbench, isStreaming: false });

  return (
    <motion.div
      initial="closed"
      animate={controller.showWorkbench ? 'open' : 'closed'}
      variants={workbenchVariants}
      className={classNames('z-workbench', { 'pointer-events-none': interaction.hiddenContentInert })}
      aria-hidden={interaction.hiddenContentInert}
      inert={interaction.hiddenContentInert}
    >
      {controller.showWorkbench && (
        <div
          className={classNames(
            'fixed top-[calc(var(--header-height)+1rem)] bottom-four w-[var(--workbench-inner-width)] z-0 transition-[left,width] duration-200 bolt-ease-cubic-bezier',
            {
              'w-full': controller.isSmallViewport,
              'left-0': controller.isSmallViewport,
              'left-[var(--workbench-left)]': !controller.isSmallViewport,
            },
          )}
        >
          <div className="absolute inset-0 px-2 lg:px-6">
            <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-border-transparent bg-bolt-elements-background-depth-2 shadow-[0_20px_60px_color-mix(in_srgb,var(--ghost-home-accent-2)_10%,transparent)]">
              <div className="flex items-center border-b border-border-transparent px-3 py-2.5">
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
                {interaction.heavyContentEnabled ? (
                  <>
                    <View {...slidingPosition({ view: 'code', selectedView: controller.selectedView })}>
                      <EditorPanel
                        editorDocument={controller.currentDocument}
                        isStreaming={!interaction.editorEditable}
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
                  </>
                ) : (
                  <div className="text-content-secondary flex size-full items-center justify-center px-6 text-center text-sm">
                    The {controller.selectedView} will be available as soon as the current build step finishes.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
}

function StreamingWorkbench({ showWorkbench }: { showWorkbench: boolean }) {
  const selectedView = useStore(workbenchStore.currentView);
  const isSmallViewport = useViewport(1024);
  const interaction = getWorkbenchInteraction({ visible: showWorkbench, isStreaming: true });

  return (
    <motion.div
      initial="closed"
      animate={showWorkbench ? 'open' : 'closed'}
      variants={workbenchVariants}
      className={classNames('z-workbench', { 'pointer-events-none': interaction.hiddenContentInert })}
      aria-hidden={interaction.hiddenContentInert}
      inert={interaction.hiddenContentInert}
    >
      {showWorkbench && (
        <div
          className={classNames(
            'fixed top-[calc(var(--header-height)+1rem)] bottom-four w-[var(--workbench-inner-width)] z-0 transition-[left,width] duration-200 bolt-ease-cubic-bezier',
            {
              'w-full': isSmallViewport,
              'left-0': isSmallViewport,
              'left-[var(--workbench-left)]': !isSmallViewport,
            },
          )}
        >
          <div className="absolute inset-0 px-2 lg:px-6">
            <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-border-transparent bg-bolt-elements-background-depth-2 shadow-[0_20px_60px_color-mix(in_srgb,var(--ghost-home-accent-2)_10%,transparent)]">
              <div className="flex items-center border-b border-border-transparent px-3 py-2.5">
                <Slider
                  selected={selectedView}
                  options={sliderOptions}
                  setSelected={(view) => workbenchStore.currentView.set(view)}
                />
                <div className="ml-auto" />
                <IconButton
                  icon={<Cross2Icon />}
                  className="-mr-1"
                  size="xl"
                  title="Close workbench"
                  onClick={() => workbenchStore.showWorkbench.set(false)}
                />
              </div>
              <div className="text-content-secondary flex flex-1 items-center justify-center px-6 text-center text-sm">
                The {selectedView} will be available as soon as the current build step finishes.
              </div>
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
}

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
