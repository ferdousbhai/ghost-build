import { useEffect, useState } from 'react';
import type { PartId } from '~/lib/stores/artifacts';
import { workbenchStore } from '~/lib/stores/workbench.client';
import type { ActionState, ActionStatus } from '~/lib/runtime/action-runner';

export function useCurrentToolStatus(): Record<string, ActionStatus> {
  const [toolStatus, setToolStatus] = useState<Record<string, ActionStatus>>({});

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
          artifactState.runner.actions.subscribe(() => setToolStatus(collectToolStatus())),
        );
      }
      setToolStatus(collectToolStatus());
    });

    return () => {
      artifactSubscription();
      partSubscriptions.forEach((unsubscribe) => unsubscribe());
    };
  }, []);

  return toolStatus;
}

function collectToolStatus(): Record<string, ActionStatus> {
  const status: Record<string, ActionStatus> = {};
  for (const artifact of Object.values(workbenchStore.artifacts.get())) {
    for (const [id, action] of Object.entries(artifact.runner.actions.get()) as Array<[string, ActionState]>) {
      status[id] = action.status;
    }
  }
  return status;
}
