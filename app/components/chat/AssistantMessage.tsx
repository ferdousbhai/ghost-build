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
import { isHiddenAssistantPart } from './assistant-message-parts';
import { DeploymentApproval } from './DeploymentApproval.client';
import { parsePendingDeploymentApproval, stripPendingDeploymentApprovalMarker } from '~/lib/deployment-approval';

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
    return hideToolCalls ? null : <ToolCall partId={partId} toolCallId={toolInvocation.toolCallId} />;
  }

  if (part.type === 'text') {
    const deployment = parsePendingDeploymentApproval(part.text);
    if (deployment) {
      const visibleText = stripPendingDeploymentApprovalMarker(part.text);
      return (
        <>
          {visibleText ? <Markdown html>{visibleText}</Markdown> : null}
          <DeploymentApproval deployment={deployment} />
        </>
      );
    }
    return <Markdown html>{part.text}</Markdown>;
  }

  if (isHiddenAssistantPart(part)) {
    return null;
  }

  captureMessage('Unknown part type ' + part.type);
  return null;
}
