export type MessageId = string & { __isMessageId: true };

export type PartId = `${MessageId}-${number}`;

export function makePartId(messageId: string, index: number): PartId {
  return `${messageId as MessageId}-${index}`;
}
