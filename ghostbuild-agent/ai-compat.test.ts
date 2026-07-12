import { describe, expect, it } from 'vitest';
import {
  cachedPromptTokens,
  isMisparsedArtifactToolPart,
  isToolPart,
  messageText,
  type GhostbuildPart,
} from './ai-compat.js';

describe('AI compatibility helpers', () => {
  it('does not treat misparsed artifact XML as a tool invocation', () => {
    const part = {
      type: 'tool-boltArtifact id="app" title="App"><boltAction type="file" filePath="src/routes/index.tsx">',
      toolCallId: 'call_1',
      state: 'input-available',
      input: {},
    } as unknown as GhostbuildPart;

    expect(isMisparsedArtifactToolPart(part)).toBe(true);
    expect(isToolPart(part)).toBe(false);
  });

  it('handles cyclic provider metadata while finding cached token usage', () => {
    const metadata: Record<string, unknown> = {};
    metadata.self = metadata;
    metadata.cloudflare = { cachedPromptTokens: 42 };

    expect(cachedPromptTokens(metadata)).toBe(42);
  });

  it('uses modern text parts when the legacy content field is empty', () => {
    expect(messageText({ content: '', parts: [{ type: 'text', text: 'hello' }] })).toBe('hello');
  });
});
