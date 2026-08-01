import { describe, expect, it } from 'vitest';
import { toolResultContent } from 'ghostbuild-agent/tool-result';
import { runLookupDocs } from './lookup-docs';

describe('lookupDocs', () => {
  it('returns the bundled guidance', async () => {
    const result = await runLookupDocs({
      state: 'call',
      toolCallId: 'tool-1',
      toolName: 'lookupDocs',
      args: { docs: ['cloudflarePlatform'] },
    });

    expect(toolResultContent(result)).toContain('Official Cloudflare skill: cloudflare');
  });
});
