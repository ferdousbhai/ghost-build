import { describe, expect, it } from 'vitest';
import { TRANSCRIPT_HISTORY_FORMAT_VERSION } from 'ghostbuild-agent/transcript';
import { parseMessageHistory, transcriptIdentityFromHeaders } from './chat-transcript-db';

const checkpoint = {
  agentName: 'agent-1',
  generation: 0,
  subchatIndex: 0,
  revision: 1,
  digest: 'a'.repeat(64),
  messageCount: 1,
};

describe('parseMessageHistory', () => {
  it('accepts only the current versioned transcript envelope', () => {
    expect(
      parseMessageHistory({
        version: TRANSCRIPT_HISTORY_FORMAT_VERSION,
        transcript: checkpoint,
        messages: [{ id: 'message-1', role: 'user', parts: [{ type: 'text', text: 'Build' }] }],
      }),
    ).toEqual({
      checkpoint,
      messages: [{ id: 'message-1', role: 'user', parts: [{ type: 'text', text: 'Build' }] }],
    });

    expect(() => parseMessageHistory([])).toThrow();
    expect(() =>
      parseMessageHistory({ version: TRANSCRIPT_HISTORY_FORMAT_VERSION - 1, transcript: checkpoint, messages: [] }),
    ).toThrow();
    expect(() =>
      parseMessageHistory({
        version: TRANSCRIPT_HISTORY_FORMAT_VERSION,
        transcript: checkpoint,
        messages: [],
        legacy: true,
      }),
    ).toThrow();
  });
});

describe('transcriptIdentityFromHeaders', () => {
  it('requires complete valid user-runtime transcript identity headers', () => {
    expect(
      transcriptIdentityFromHeaders(
        new Headers({
          'X-Ghostbuild-Transcript-Agent': 'agent-1',
          'X-Ghostbuild-Transcript-Generation': '2',
          'X-Ghostbuild-Transcript-Subchat': '3',
        }),
      ),
    ).toEqual({ agentName: 'agent-1', generation: 2, subchatIndex: 3 });

    expect(() => transcriptIdentityFromHeaders(new Headers())).toThrow('invalid transcript identity headers');
    expect(() =>
      transcriptIdentityFromHeaders(
        new Headers({
          'X-Ghostbuild-Transcript-Agent': 'agent-1',
          'X-Ghostbuild-Transcript-Generation': 'invalid',
          'X-Ghostbuild-Transcript-Subchat': '3',
        }),
      ),
    ).toThrow('invalid transcript identity headers');
    expect(() =>
      transcriptIdentityFromHeaders(
        new Headers({
          'X-Ghostbuild-Transcript-Agent': 'agent-1',
          'X-Ghostbuild-Transcript-Generation': '',
          'X-Ghostbuild-Transcript-Subchat': '3',
        }),
      ),
    ).toThrow('invalid transcript identity headers');
  });
});
