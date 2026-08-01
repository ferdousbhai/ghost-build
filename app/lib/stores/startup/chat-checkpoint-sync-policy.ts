import type { CompleteMessageInfo } from './messages';

export function isCompleteMessageInfoAtLeast(
  current: Pick<CompleteMessageInfo, 'messageIndex' | 'partIndex'> | null,
  expected: Pick<CompleteMessageInfo, 'messageIndex' | 'partIndex'>,
): boolean {
  if (current === null) {
    return false;
  }
  if (current.messageIndex !== expected.messageIndex) {
    return current.messageIndex > expected.messageIndex;
  }
  return current.partIndex >= expected.partIndex;
}
