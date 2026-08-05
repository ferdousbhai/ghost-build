import { useStore } from '@nanostores/react';
import { motion } from 'framer-motion';
import { memo, useMemo, useState } from 'react';
import type { GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import type { PartId } from 'ghostbuild-agent/partId';
import { ToolUseContents } from './ToolUseContents';
import { normalizeToolInvocation, statusIcon, toolTitle } from './tool-call-presentation';
import { ExpandableToolCard } from './ExpandableToolCard';
import { invocationStatus, toolActivityStore } from '~/lib/stores/tool-activity.client';

export const ToolCall = memo(function ToolCall({
  partId,
  invocation: rawInvocation,
}: {
  partId: PartId;
  invocation: GhostbuildToolInvocation;
}) {
  const activities = useStore(toolActivityStore.activities);
  const [showAction, setShowAction] = useState(false);
  const activity = activities[partId];
  const invocation = useMemo(
    () => normalizeToolInvocation(activity?.invocation ?? rawInvocation),
    [activity?.invocation, rawInvocation],
  );
  const status = activity?.status ?? invocationStatus(invocation);

  const toggleAction = () => {
    setShowAction((visible) => !visible);
  };

  return (
    <ExpandableToolCard
      expanded={showAction}
      header={
        <div className="flex items-center gap-1.5">
          <div className="w-full text-sm font-medium leading-5 text-content-primary">{toolTitle(invocation)}</div>
          {statusIcon(status, invocation)}
        </div>
      }
      onToggle={toggleAction}
      toggleDisabled={invocation.state === 'input-streaming'}
      body={
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="space-y-2.5">
            <ToolUseContents invocation={invocation} />
          </div>
        </motion.div>
      }
    />
  );
});
