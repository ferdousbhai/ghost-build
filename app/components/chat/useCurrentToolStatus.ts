import { useEffect, useState } from 'react';
import type { PartId } from '~/lib/stores/artifacts';
import { workbenchStore } from '~/lib/stores/workbench.client';
import type { ActionState, ActionStatus } from '~/lib/runtime/action-runner';

export function useCurrentToolStatus(): {
  toolStatus: Record<string, ActionStatus>;
  activeToolNames: string[];
  activityRevision: number;
} {
  const [toolStatus, setToolStatus] = useState<Record<string, ActionStatus>>({});
  const [activityRevision, setActivityRevision] = useState(0);
  const [activeToolNames, setActiveToolNames] = useState<string[]>([]);

  useEffect(() => {
    const partSubscriptions = new Map<PartId, () => void>();
    const artifactSubscription = workbenchStore.artifacts.subscribe((artifacts) => {
      const activePartIds = new Set(Object.keys(artifacts) as PartId[]);
      for (const [partId, unsubscribe] of partSubscriptions) {
        if (!activePartIds.has(partId)) {
          unsubscribe();
          partSubscriptions.delete(partId);
        }
      }
      for (const [partId, artifactState] of Object.entries(artifacts)) {
        const typedPartId = partId as PartId;
        if (partSubscriptions.has(typedPartId)) {
          continue;
        }
        partSubscriptions.set(
          typedPartId,
          artifactState.runner.actions.subscribe(() => {
            const activity = collectToolActivity();
            setToolStatus(activity.status);
            setActiveToolNames(activity.activeToolNames);
            setActivityRevision((revision) => revision + 1);
          }),
        );
      }
      const activity = collectToolActivity();
      setToolStatus(activity.status);
      setActiveToolNames(activity.activeToolNames);
    });

    return () => {
      artifactSubscription();
      partSubscriptions.forEach((unsubscribe) => unsubscribe());
    };
  }, []);

  return { toolStatus, activeToolNames, activityRevision };
}

function collectToolActivity(): { status: Record<string, ActionStatus>; activeToolNames: string[] } {
  const status: Record<string, ActionStatus> = {};
  const activeToolNames = new Set<string>();
  for (const artifact of Object.values(workbenchStore.artifacts.get())) {
    for (const [id, action] of Object.entries(artifact.runner.actions.get()) as Array<[string, ActionState]>) {
      status[id] = action.status;
      if (
        (action.status === 'pending' || action.status === 'running') &&
        action.type === 'toolUse' &&
        action.parsedContent.toolName
      ) {
        activeToolNames.add(action.parsedContent.toolName);
      }
    }
  }
  return { status, activeToolNames: [...activeToolNames] };
}
