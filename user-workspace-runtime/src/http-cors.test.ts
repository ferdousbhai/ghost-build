import { describe, expect, it } from 'vitest';
import { withCors } from './http-cors';

describe('user runtime CORS', () => {
  it('exposes the transcript identity required by the cross-origin browser client', () => {
    const response = withCors(
      new Response(null, {
        headers: {
          'X-Ghostbuild-Transcript-Agent': 'agent-1',
          'X-Ghostbuild-Transcript-Generation': '2',
          'X-Ghostbuild-Transcript-Subchat': '3',
        },
      }),
      'https://ghostbuild.dev',
    );

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://ghostbuild.dev');
    expect(response.headers.get('Access-Control-Expose-Headers')?.split(', ')).toEqual([
      'X-Ghostbuild-Transcript-Agent',
      'X-Ghostbuild-Transcript-Generation',
      'X-Ghostbuild-Transcript-Subchat',
    ]);
  });
});
