import { useStore } from '@nanostores/react';
import { useMemo } from 'react';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { makePartId, type PartId } from 'ghostbuild-agent/partId';
import { isToolActivityStatusActive } from '~/lib/common/types';
import { toolActivityStore } from '~/lib/stores/tool-activity.client';

type ToolActivities = ReturnType<(typeof toolActivityStore.activities)['get']>;

export function useCurrentToolStatus(messages: GhostbuildMessage[]): {
  activeToolNames: string[];
  activityRevision: number;
} {
  const activities = useStore(toolActivityStore.activities);
  const activityRevision = useStore(toolActivityStore.revision);
  return useMemo(
    () => currentToolStatus(messages, activities, activityRevision),
    [activities, activityRevision, messages],
  );
}

export function currentToolStatus(messages: GhostbuildMessage[], activities: ToolActivities, activityRevision = 0) {
  const currentPartIds = new Set<PartId>();
  for (const message of messages) {
    message.parts?.forEach((_part, index) => currentPartIds.add(makePartId(message.id, index)));
  }
  const activeToolNames = new Set<string>();
  for (const [partId, activity] of Object.entries(activities) as Array<[PartId, ToolActivities[PartId]]>) {
    if (!currentPartIds.has(partId)) {
      continue;
    }
    if (isToolActivityStatusActive(activity.status) && activity.invocation.toolName) {
      activeToolNames.add(activity.invocation.toolName);
    }
  }
  return { activeToolNames: [...activeToolNames], activityRevision };
}
