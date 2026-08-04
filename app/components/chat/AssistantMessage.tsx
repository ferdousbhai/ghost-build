import { memo } from 'react';
import { Markdown } from './Markdown';
import { ToolCall } from './ToolCall';
import { makePartId, type PartId } from 'ghostbuild-agent/partId.js';
import {
  getToolInvocation,
  messageText,
  type GhostbuildMessage,
  type GhostbuildPart,
} from 'ghostbuild-agent/ai-compat';
import { captureMessage } from '~/lib/telemetry.client';
import { DeploymentApproval } from './DeploymentApproval.client';

interface AssistantMessageProps {
  message: GhostbuildMessage;
  isStreaming?: boolean;
}

export const AssistantMessage = memo(function AssistantMessage({ message, isStreaming }: AssistantMessageProps) {
  if (!message.parts) {
    return (
      <div className="w-full overflow-hidden">
        <Markdown html>{messageText(message)}</Markdown>
      </div>
    );
  }

  return (
    <div className="w-full overflow-hidden text-sm">
      <div className="flex flex-col gap-2">
        {message.parts.map((part, index) => (
          <AssistantMessagePart
            key={index}
            part={part}
            partId={makePartId(message.id, index)}
            hideToolCalls={isStreaming === true}
          />
        ))}
      </div>
    </div>
  );
});

function AssistantMessagePart({
  part,
  partId,
  hideToolCalls,
}: {
  part: GhostbuildPart;
  partId: PartId;
  hideToolCalls: boolean;
}) {
  const toolInvocation = getToolInvocation(part);
  if (toolInvocation) {
    return hideToolCalls ? null : <ToolCall partId={partId} invocation={toolInvocation} />;
  }

  if (part.type === 'text') {
    return <Markdown html>{part.text}</Markdown>;
  }

  if (part.type === 'data-deployment-approval') {
    return <DeploymentApproval deployment={part.data} />;
  }

  if (part.type === 'step-start' || part.type === 'reasoning' || part.type === 'reasoning-file') {
    return null;
  }

  captureMessage('Unknown assistant message part');
  return null;
}
