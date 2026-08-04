import { describe, expect, it } from 'vitest';
import { transcriptIdentityFromHeaders } from './chat-transcript-db';

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
