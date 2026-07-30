import { useStore } from '@nanostores/react';
import { useMemo } from 'react';
import type { ToolActivityStatus } from '~/lib/common/types';
import { isToolActivityStatusActive } from '~/lib/common/types';
import { toolActivityStore } from '~/lib/stores/tool-activity.client';

export function useCurrentToolStatus(): {
  toolStatus: Record<string, ToolActivityStatus>;
  activeToolNames: string[];
  activityRevision: number;
} {
  const activities = useStore(toolActivityStore.activities);
  const activityRevision = useStore(toolActivityStore.revision);
  return useMemo(() => {
    const toolStatus: Record<string, ToolActivityStatus> = {};
    const activeToolNames = new Set<string>();
    for (const activity of Object.values(activities)) {
      toolStatus[activity.invocation.toolCallId] = activity.status;
      if (isToolActivityStatusActive(activity.status) && activity.invocation.toolName) {
        activeToolNames.add(activity.invocation.toolName);
      }
    }
    return { toolStatus, activeToolNames: [...activeToolNames], activityRevision };
  }, [activities, activityRevision]);
}
