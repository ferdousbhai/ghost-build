import { useEffect, useMemo, useState } from 'react';
import { getToolInvocation, type GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import type { StreamStatus } from '~/lib/common/types';
import { getBuildProgress } from './build-progress';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';

const CLOCK_INTERVAL_MS = 1_000;

export function useBuildProgress(args: {
  streamStatus: StreamStatus;
  isRecovering: boolean;
  isProjectUpdate: boolean;
  activeToolNames: string[];
  validationStage: BuilderValidationStage | null;
  toolActivityRevision: number;
  messages: GhostbuildMessage[];
}) {
  const activeToolActivity = args.activeToolNames.toSorted().join(',');
  const activityKey = useMemo(
    () =>
      `${messageActivityKey(args.messages)}:${args.toolActivityRevision}:${activeToolActivity}:${args.streamStatus}:${args.isRecovering}:${args.isProjectUpdate}:${args.validationStage ?? ''}`,
    [
      activeToolActivity,
      args.isProjectUpdate,
      args.isRecovering,
      args.messages,
      args.streamStatus,
      args.toolActivityRevision,
      args.validationStage,
    ],
  );
  const [clock, setClock] = useState(() => {
    const timestamp = Date.now();
    return { activityKey, lastActivityAt: timestamp, now: timestamp };
  });

  useEffect(() => {
    const timestamp = Date.now();
    setClock({ activityKey, lastActivityAt: timestamp, now: timestamp });
  }, [activityKey]);

  const active = args.isRecovering || args.streamStatus === 'submitted' || args.streamStatus === 'streaming';
  useEffect(() => {
    if (!active) {
      return () => undefined;
    }
    const interval = window.setInterval(
      () => setClock((current) => (current.activityKey === activityKey ? { ...current, now: Date.now() } : current)),
      CLOCK_INTERVAL_MS,
    );
    return () => window.clearInterval(interval);
  }, [active, activityKey]);

  return getBuildProgress({
    streamStatus: args.streamStatus,
    isRecovering: args.isRecovering,
    isProjectUpdate: args.isProjectUpdate,
    activeToolNames: args.activeToolNames,
    validationStage: args.validationStage,
    inactiveForMs: clock.activityKey === activityKey ? Math.max(0, clock.now - clock.lastActivityAt) : 0,
  });
}

function messageActivityKey(messages: GhostbuildMessage[]): string {
  const lastMessage = messages.at(-1);
  if (!lastMessage) {
    return 'empty';
  }
  const partActivity =
    lastMessage.parts
      ?.map((part) => {
        if (part.type === 'text') {
          return `text:${typeof part.text === 'string' ? part.text.length : 0}`;
        }
        const invocation = getToolInvocation(part);
        return invocation ? `tool:${invocation.toolCallId}:${invocation.toolName}:${invocation.state}` : part.type;
      })
      .join(',') ?? '';
  return `${messages.length}:${lastMessage.id}:${partActivity}`;
}
