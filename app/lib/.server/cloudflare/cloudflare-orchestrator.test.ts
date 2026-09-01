import { describe, expect, it } from 'vitest';
import { CloudflareOrchestratorUnavailableError, UnavailableCloudflareOrchestrator } from './cloudflare-orchestrator';

describe('UnavailableCloudflareOrchestrator', () => {
  it('fails closed instead of collecting a user API token', async () => {
    const orchestrator = new UnavailableCloudflareOrchestrator();
    await expect(
      orchestrator.startConnection({
        returnUrl: 'https://ghostbuild.dev/cloudflare/callback',
      }),
    ).rejects.toBeInstanceOf(CloudflareOrchestratorUnavailableError);
    await expect(
      orchestrator.completeConnection({
        providerSessionId: 'provider-session',
        callbackUrl: 'https://ghostbuild.dev/api/cloudflare/connection/callback?state=state',
      }),
    ).rejects.toBeInstanceOf(CloudflareOrchestratorUnavailableError);
  });
});
