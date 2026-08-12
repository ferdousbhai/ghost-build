export type AiGatewayCreditStatus = 'available' | 'unavailable' | 'unknown';

export function isAiGatewayCreditStatus(value: unknown): value is AiGatewayCreditStatus {
  return value === 'available' || value === 'unavailable' || value === 'unknown';
}
