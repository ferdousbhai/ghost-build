export function isHiddenAssistantPart(part: { type: string }) {
  return part.type === 'step-start' || part.type === 'reasoning';
}
