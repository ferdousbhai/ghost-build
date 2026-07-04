import { useStore } from '@nanostores/react';
import { AnimatePresence, motion } from 'framer-motion';
import { computed } from 'nanostores';
import { memo, useEffect, useRef, useState } from 'react';
import { FileIcon, CaretUpIcon, CaretDownIcon, CircleIcon, CheckIcon, Cross2Icon } from '@radix-ui/react-icons';
import type { ActionState } from '~/lib/runtime/action-runner';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { type PartId } from '~/lib/stores/artifacts';
import { classNames } from '~/utils/classNames';
import { cubicEasingFn } from '~/utils/easings';
import { summarize } from '~/utils/summarize';
import type { RelativePath } from 'ghostbuild-agent/utils/workDir';
import { getAbsolutePath } from 'ghostbuild-agent/utils/workDir';
import { Spinner } from '@ui/Spinner';
import { captureException } from '~/lib/telemetry.client';

interface ArtifactProps {
  partId: PartId;
}

export const Artifact = memo(function Artifact({ partId }: ArtifactProps) {
  const userToggledActions = useRef(false);
  const [showActions, setShowActions] = useState(false);

  const artifacts = useStore(workbenchStore.artifacts);
  const artifact = artifacts[partId];

  const actions = useStore(
    computed(artifact.runner.actions, (actions) => {
      return Object.values(actions);
    }),
  );
  const allActionsFinished = actions.length > 0 && actions.every((action) => action.status === 'complete');

  const toggleActions = () => {
    userToggledActions.current = true;
    setShowActions(!showActions);
  };

  useEffect(() => {
    if (actions.length > 0 && !showActions && !userToggledActions.current) {
      setShowActions(true);
    }
    // We only want to run this when `actions` changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions]);

  return (
    <div className="artifact flex w-full flex-col overflow-hidden rounded-lg border">
      <div className="flex">
        <button
          className="flex w-full items-stretch overflow-hidden bg-bolt-elements-artifacts-background hover:bg-bolt-elements-artifacts-backgroundHover"
          onClick={() => {
            const showWorkbench = workbenchStore.showWorkbench.get();
            workbenchStore.showWorkbench.set(!showWorkbench);
          }}
        >
          {artifact.type === 'bundled' && (
            <>
              <div className="p-4">{allActionsFinished ? <FileIcon /> : <Spinner />}</div>
              <div className="w-px bg-bolt-elements-artifacts-borderColor" />
            </>
          )}
          <div className="w-full p-3.5 px-5 text-left">
            <div className="text-content-primary w-full text-sm font-medium leading-5">{artifact?.title}</div>
            <div className="text-content-secondary mt-0.5 w-full text-xs">Click to open Workbench</div>
          </div>
        </button>
        <div className="w-px bg-bolt-elements-artifacts-borderColor" />
        <AnimatePresence>
          {actions.length > 0 && artifact.type !== 'bundled' && (
            <motion.button
              initial={{ width: 0 }}
              animate={{ width: 'auto' }}
              exit={{ width: 0 }}
              transition={{ duration: 0.15, ease: cubicEasingFn }}
              className="bg-bolt-elements-artifacts-background hover:bg-bolt-elements-artifacts-backgroundHover"
              onClick={toggleActions}
            >
              <div className="p-4">{showActions ? <CaretUpIcon /> : <CaretDownIcon />}</div>
            </motion.button>
          )}
        </AnimatePresence>
      </div>
      <AnimatePresence>
        {artifact.type !== 'bundled' && showActions && actions.length > 0 && (
          <motion.div
            className="actions"
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: '0px' }}
            transition={{ duration: 0.15 }}
          >
            <div className="h-px bg-bolt-elements-artifacts-borderColor" />

            <div className="bg-bolt-elements-actions-background p-5 text-left">
              <ActionList actions={actions} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

interface ActionListProps {
  actions: ActionState[];
}

const actionVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 },
};

function openArtifactInWorkbench(filePath: RelativePath) {
  if (workbenchStore.currentView.get() !== 'code') {
    workbenchStore.currentView.set('code');
  }
  workbenchStore.resumeFollowingStreamedCode();
  workbenchStore.setSelectedFile(getAbsolutePath(filePath));
}

const ActionList = memo(function ActionList({ actions }: ActionListProps) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
      <ul className="list-none space-y-2.5">
        {actions.map((action, index) => {
          const { status, type } = action;
          if (type !== 'file') {
            // This happens a ton, it's just telling us that our TypeScript types are wrong, we have an action that
            // surprises us.
            if (Math.random() < 0.001) {
              captureException(
                `Action is not a file (so our typescript types are wrong): ${JSON.stringify(summarize(action))}`,
              );
            }
            return null;
          }
          const message = action.isEdit ? 'Edit' : 'Create';
          return (
            <motion.li
              key={index}
              variants={actionVariants}
              initial="hidden"
              animate="visible"
              transition={{
                duration: 0.2,
                ease: cubicEasingFn,
              }}
            >
              <div className="flex items-center gap-1.5 text-sm">
                <div className={classNames('text-lg', getIconColor(action.status))}>{getStatusIcon(status)}</div>
                <div>
                  {message}{' '}
                  <code
                    className="cursor-pointer rounded-md bg-bolt-elements-artifacts-inlineCode-background px-1.5 py-1 text-bolt-elements-artifacts-inlineCode-text text-bolt-elements-item-contentAccent hover:underline"
                    onClick={() => openArtifactInWorkbench(action.filePath)}
                  >
                    {action.filePath}
                  </code>
                </div>
              </div>
            </motion.li>
          );
        })}
      </ul>
    </motion.div>
  );
});

function getStatusIcon(status: ActionState['status']) {
  switch (status) {
    case 'running':
      return <Spinner />;
    case 'pending':
      return <CircleIcon />;
    case 'complete':
      return <CheckIcon />;
    case 'failed':
    case 'aborted':
      return <Cross2Icon />;
    default:
      return null;
  }
}

function getIconColor(status: ActionState['status']) {
  switch (status) {
    case 'pending': {
      return 'text-content-tertiary';
    }
    case 'running': {
      return 'text-bolt-elements-loader-progress';
    }
    case 'complete': {
      return 'text-bolt-elements-icon-success';
    }
    case 'aborted': {
      return 'text-content-secondary';
    }
    case 'failed': {
      return 'text-bolt-elements-icon-error';
    }
    default: {
      return undefined;
    }
  }
}
