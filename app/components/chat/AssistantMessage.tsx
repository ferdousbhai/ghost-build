import { lazy, memo, Suspense } from 'react';
import { ToolCall } from './ToolCall';
import { makePartId, type PartId } from 'ghostbuild-agent/partId.js';
import {
  getToolInvocation,
  messageText,
  type GhostbuildMessage,
  type GhostbuildPart,
} from 'ghostbuild-agent/ai-compat';
import { captureMessage } from '~/lib/telemetry.client';

const Markdown = lazy(() => import('./Markdown').then((module) => ({ default: module.Markdown })));

interface AssistantMessageProps {
  message: GhostbuildMessage;
}

export const AssistantMessage = memo(function AssistantMessage({ message }: AssistantMessageProps) {
  if (!message.parts) {
    return (
      <div className="w-full overflow-hidden">
        <Suspense fallback={null}>
          <Markdown>{messageText(message)}</Markdown>
        </Suspense>
      </div>
    );
  }

  return (
    <div className="w-full overflow-hidden text-sm">
      <div className="flex flex-col gap-2">
        {message.parts.map((part, index) => (
          <AssistantMessagePart key={index} part={part} partId={makePartId(message.id, index)} />
        ))}
      </div>
    </div>
  );
});

function AssistantMessagePart({ part, partId }: { part: GhostbuildPart; partId: PartId }) {
  const toolInvocation = getToolInvocation(part);
  if (toolInvocation) {
    return <ToolCall partId={partId} invocation={toolInvocation} />;
  }

  if (part.type === 'text') {
    return typeof part.text === 'string' ? (
      <Suspense fallback={null}>
        <Markdown>{part.text}</Markdown>
      </Suspense>
    ) : null;
  }

  if (part.type === 'data-deployment-approval') {
    return null;
  }

  if (part.type === 'step-start' || part.type === 'reasoning' || part.type === 'reasoning-file') {
    return null;
  }

  captureMessage('Unknown assistant message part');
  return null;
}
