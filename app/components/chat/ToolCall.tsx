import { useStore } from '@nanostores/react';
import { motion } from 'framer-motion';
import { memo, useMemo, useState } from 'react';
import type { GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { workbenchStore } from '~/lib/stores/workbench.client';
import type { PartId } from '~/lib/stores/artifacts';
import { ToolUseContents } from './ToolUseContents';
import { parseToolInvocation, statusIcon, toolTitle } from './tool-call-presentation';
import { ExpandableArtifactCard } from './ExpandableArtifactCard';
import type { ArtifactState } from '~/lib/stores/workbench-artifacts';

export const ToolCall = memo(function ToolCall({ partId, toolCallId }: { partId: PartId; toolCallId: string }) {
  const artifacts = useStore(workbenchStore.artifacts);
  const artifact = artifacts[partId];
  if (!artifact) {
    return null;
  }
  return <ToolCallContents artifact={artifact} toolCallId={toolCallId} />;
});

const ToolCallContents = memo(function ToolCallContents({
  artifact,
  toolCallId,
}: {
  artifact: ArtifactState;
  toolCallId: string;
}) {
  const [showAction, setShowAction] = useState(false);
  const actions = useStore(artifact.runner.actions);
  const action = actions[toolCallId];

  const invocation: GhostbuildToolInvocation = useMemo(() => parseToolInvocation(action?.content), [action?.content]);

  if (!action) {
    return null;
  }

  const toggleAction = () => {
    setShowAction((visible) => !visible);
  };

  const expandable = artifact.type !== 'bundled';
  return (
    <ExpandableArtifactCard
      expanded={expandable && showAction}
      header={
        <div className="flex items-center gap-1.5">
          <div className="w-full text-sm font-medium leading-5 text-content-primary">{toolTitle(invocation)}</div>
          {statusIcon(action.status, invocation)}
        </div>
      }
      onOpen={() => workbenchStore.showWorkbench.set(!workbenchStore.showWorkbench.get())}
      onToggle={expandable ? toggleAction : undefined}
      toggleDisabled={invocation.state === 'partial-call'}
      body={
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <ul className="list-none space-y-2.5">
            <ToolUseContents invocation={invocation} />
          </ul>
        </motion.div>
      }
    />
  );
});
