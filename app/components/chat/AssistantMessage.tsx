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
import { parsePendingDeploymentApprovalData } from '~/lib/deployment-approval';

interface AssistantMessageProps {
  message: GhostbuildMessage;
  isStreaming?: boolean;
}

export const AssistantMessage = memo(function AssistantMessage({ message }: AssistantMessageProps) {
  if (!message.parts) {
    return (
      <div className="w-full overflow-hidden">
        <Markdown>{messageText(message)}</Markdown>
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
    return typeof part.text === 'string' ? <Markdown>{part.text}</Markdown> : null;
  }

  if (part.type === 'data-deployment-approval') {
    const deployment = parsePendingDeploymentApprovalData(part.data);
    return deployment ? <DeploymentApproval deployment={deployment} /> : null;
  }

  if (part.type === 'step-start' || part.type === 'reasoning' || part.type === 'reasoning-file') {
    return null;
  }

  captureMessage('Unknown assistant message part');
  return null;
}
