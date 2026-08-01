import { useEffect, useMemo, useRef, useState } from 'react';
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
  const activityKey = useMemo(
    () =>
      `${messageActivityKey(args.messages)}:${args.toolActivityRevision}:${args.streamStatus}:${args.isRecovering}:${args.isProjectUpdate}:${args.validationStage ?? ''}`,
    [
      args.isProjectUpdate,
      args.isRecovering,
      args.messages,
      args.streamStatus,
      args.toolActivityRevision,
      args.validationStage,
    ],
  );
  const lastActivityAt = useRef(Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    lastActivityAt.current = Date.now();
    setNow(lastActivityAt.current);
  }, [activityKey]);

  const active = args.isRecovering || args.streamStatus === 'submitted' || args.streamStatus === 'streaming';
  useEffect(() => {
    if (!active) {
      return () => undefined;
    }
    const interval = window.setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [active]);

  return getBuildProgress({
    streamStatus: args.streamStatus,
    isRecovering: args.isRecovering,
    isProjectUpdate: args.isProjectUpdate,
    activeToolNames: args.activeToolNames,
    validationStage: args.validationStage,
    inactiveForMs: Math.max(0, now - lastActivityAt.current),
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
          return `text:${part.text.length}`;
        }
        const invocation = getToolInvocation(part);
        return invocation ? `tool:${invocation.toolCallId}:${invocation.toolName}:${invocation.state}` : part.type;
      })
      .join(',') ?? '';
  return `${messages.length}:${lastMessage.id}:${partActivity}`;
}
