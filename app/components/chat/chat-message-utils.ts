import { getToolInvocation, type GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { MAX_CONSECUTIVE_DEPLOY_ERRORS } from '~/utils/constants';

export function textFromParts(parts: GhostbuildMessage['parts']): string {
  return parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

export function hasTooManyConsecutiveToolFailures(messages: GhostbuildMessage[]): boolean {
  const lastMessage = messages.at(-1);
  if (lastMessage?.role !== 'assistant') {
    return false;
  }
  const toolResults = lastMessage.parts.flatMap((part) => {
    const invocation = getToolInvocation(part);
    return invocation?.state === 'result' ? [invocation] : [];
  });
  if (toolResults.length < MAX_CONSECUTIVE_DEPLOY_ERRORS) {
    return false;
  }
  return toolResults.slice(-MAX_CONSECUTIVE_DEPLOY_ERRORS).every((invocation) => {
    const result = typeof invocation.result === 'string' ? invocation.result : JSON.stringify(invocation.result);
    return result.startsWith('Error:');
  });
}
