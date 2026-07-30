import { motion, type HTMLMotionProps, type Variants } from 'framer-motion';
import {
  lazy,
  memo,
  Suspense,
  useEffect,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import { IconButton } from '~/components/ui/IconButton';
import { PanelHeaderButton } from '~/components/ui/PanelHeaderButton';
import { Slider, type SliderOptions } from '~/components/ui/Slider';
import type { WorkbenchViewType } from '~/lib/stores/workbench.client';
import { classNames } from '~/utils/classNames';
import { cubicEasingFn } from '~/utils/easings';
import { renderLogger } from 'ghostbuild-agent/utils/logger';
import { EditorPanel } from './EditorPanel';
import { Cross2Icon } from '@radix-ui/react-icons';
import { useWorkbenchController } from './useWorkbenchController';
import { useStore } from '@nanostores/react';
import { workbenchStore } from '~/lib/stores/workbench.client';

interface WorkbenchProps {
  chatStarted?: boolean;
  isStreaming?: boolean;
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

export const Workbench = memo(function Workbench({ chatStarted, isStreaming }: WorkbenchProps) {
  renderLogger.trace('Workbench');
  const showWorkbench = useStore(workbenchStore.showWorkbench);
  const [hasMountedWorkbench, setHasMountedWorkbench] = useState(showWorkbench);

  useEffect(() => {
    if (showWorkbench) {
      setHasMountedWorkbench(true);
    }
  }, [showWorkbench]);

  if (!chatStarted || !hasMountedWorkbench) {
    return null;
  }

  return <ReadyWorkbench isStreaming={isStreaming} />;
});

function ReadyWorkbench({ isStreaming }: Pick<WorkbenchProps, 'isStreaming'>) {
  const controller = useWorkbenchController(isStreaming);

  return (
    <WorkbenchFrame
      visible={controller.showWorkbench}
      selectedView={controller.selectedView}
      setSelectedView={controller.setSelectedView}
      isSmallViewport={controller.isSmallViewport}
      onClose={controller.close}
      lockedMessage={
        isStreaming ? 'Code and preview controls will be available as soon as the current build step finishes.' : null
      }
      headerActions={
        controller.selectedView === 'code' ? (
          <PanelHeaderButton className="mr-1 text-sm" onClick={() => void controller.onFileSave()}>
            Save
          </PanelHeaderButton>
        ) : null
      }
    >
      <>
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
    </WorkbenchFrame>
  );
}

function WorkbenchFrame({
  visible,
  selectedView,
  setSelectedView,
  isSmallViewport,
  onClose,
  lockedMessage,
  headerActions,
  children,
}: {
  visible: boolean;
  selectedView: WorkbenchViewType;
  setSelectedView: (view: WorkbenchViewType) => void;
  isSmallViewport: boolean;
  onClose: () => void;
  lockedMessage?: ReactNode;
  headerActions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <motion.div
      initial="closed"
      animate={visible ? 'open' : 'closed'}
      variants={workbenchVariants}
      className={classNames('z-workbench', { 'pointer-events-none': !visible })}
      style={isSmallViewport ? ({ '--workbench-width': '100vw' } as CSSProperties) : undefined}
      aria-hidden={!visible}
      inert={!visible}
    >
      <div
        className={classNames(
          'fixed top-[calc(var(--header-height)+1rem)] bottom-four w-[var(--workbench-inner-width)] z-0 transition-[left,width] duration-200 bolt-ease-cubic-bezier',
          {
            invisible: !visible,
            'w-full': isSmallViewport,
            'left-0': isSmallViewport,
            'left-[var(--workbench-left)]': !isSmallViewport,
          },
        )}
      >
        <div className="absolute inset-0 px-2 lg:px-6">
          <div className="relative flex h-full flex-col overflow-hidden rounded-2xl border border-border-transparent bg-bolt-elements-background-depth-2 shadow-[0_20px_60px_color-mix(in_srgb,var(--ghost-home-accent-2)_10%,transparent)]">
            <div className="flex items-center border-b border-border-transparent px-3 py-2.5">
              <Slider selected={selectedView} options={sliderOptions} setSelected={setSelectedView} />
              <div className="ml-auto" />
              <div inert={Boolean(lockedMessage)}>{headerActions}</div>
              <IconButton icon={<Cross2Icon />} className="-mr-1" size="xl" title="Close workbench" onClick={onClose} />
            </div>
            <div className="relative flex-1 overflow-hidden">
              <div className="size-full" inert={Boolean(lockedMessage)}>
                {children}
              </div>
              {lockedMessage && (
                <div className="absolute inset-0 z-20 flex items-center justify-center bg-bolt-elements-background-depth-2 px-6 text-center text-sm text-content-secondary">
                  {lockedMessage}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
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
