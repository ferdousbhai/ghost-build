export class DataNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataNotFoundError';
  }
}

export class ChatStorageRetentionError extends Error {
  constructor() {
    super('Chat history retention is at capacity. Retry after older checkpoints are compacted.');
    this.name = 'ChatStorageRetentionError';
  }
}

export class SubchatLimitError extends Error {
  constructor() {
    super('This project has reached the maximum number of subchats.');
    this.name = 'SubchatLimitError';
  }
}
