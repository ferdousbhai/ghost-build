import { useStore } from '@nanostores/react';
import { motion } from 'framer-motion';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { FileIcon, CircleIcon, CheckIcon, Cross2Icon } from '@radix-ui/react-icons';
import type { ActionState } from '~/lib/runtime/action-runner';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { type PartId } from '~/lib/stores/artifacts';
import { classNames } from '~/utils/classNames';
import { cubicEasingFn } from '~/utils/easings';
import type { RelativePath } from 'ghostbuild-agent/utils/workDir';
import { getAbsolutePath } from 'ghostbuild-agent/utils/workDir';
import { Spinner } from '@ui/Spinner';
import { ExpandableArtifactCard } from './ExpandableArtifactCard';
import type { ArtifactState } from '~/lib/stores/workbench-artifacts';

interface ArtifactProps {
  partId: PartId;
}

export const Artifact = memo(function Artifact({ partId }: ArtifactProps) {
  const artifacts = useStore(workbenchStore.artifacts);
  const artifact = artifacts[partId];
  if (!artifact) {
    return null;
  }
  return <ArtifactContents artifact={artifact} />;
});

const ArtifactContents = memo(function ArtifactContents({ artifact }: { artifact: ArtifactState }) {
  const userToggledActions = useRef(false);
  const [showActions, setShowActions] = useState(false);
  const actionMap = useStore(artifact.runner.actions);
  const actions = useMemo(() => Object.values(actionMap), [actionMap]);
  const allActionsFinished = actions.length > 0 && actions.every((action) => action.status === 'complete');

  const toggleActions = () => {
    userToggledActions.current = true;
    setShowActions((current) => !current);
  };

  useEffect(() => {
    if (actions.length > 0 && !showActions && !userToggledActions.current) {
      setShowActions(true);
    }
  }, [actions, showActions]);

  const expandable = actions.length > 0 && artifact.type !== 'bundled';
  return (
    <ExpandableArtifactCard
      expanded={expandable && showActions}
      leading={artifact.type === 'bundled' ? allActionsFinished ? <FileIcon /> : <Spinner /> : undefined}
      header={
        <>
          <div className="w-full text-sm font-medium leading-5 text-content-primary">{artifact.title}</div>
          <div className="mt-0.5 w-full text-xs text-content-secondary">Click to open Workbench</div>
        </>
      }
      onOpen={() => workbenchStore.showWorkbench.set(!workbenchStore.showWorkbench.get())}
      onToggle={expandable ? toggleActions : undefined}
      body={expandable ? <ActionList actions={actions} /> : undefined}
    />
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
                  <button
                    type="button"
                    className="cursor-pointer rounded-md bg-bolt-elements-artifacts-inlineCode-background px-1.5 py-1 font-mono text-bolt-elements-artifacts-inlineCode-text text-bolt-elements-item-contentAccent hover:underline"
                    onClick={() => openArtifactInWorkbench(action.filePath)}
                  >
                    {action.filePath}
                  </button>
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
