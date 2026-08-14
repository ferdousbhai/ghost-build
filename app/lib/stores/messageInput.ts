import { atom } from 'nanostores';

export const messageInputStore = atom('');

let revision = 0;

export function setMessageInput(value: string): void {
  revision++;
  messageInputStore.set(value);
}

export function getMessageInputRevision(): number {
  return revision;
}
