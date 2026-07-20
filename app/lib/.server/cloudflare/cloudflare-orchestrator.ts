export type CloudflareConnectionRequest = {
  returnUrl: string;
  requestedCapabilities: Array<'workers' | 'd1' | 'r2' | 'durable_objects' | 'workers_ai'>;
};

export type CloudflareConnectionChallenge = {
  sessionId: string;
  authorizationUrl: string;
  expiresAt: number;
};

export type CloudflareConnectionCompletionRequest = {
  providerSessionId: string;
  callbackUrl: string;
};

export type CloudflareConnectionResult = {
  user: {
    subject: string;
    email: string | null;
    name: string | null;
    picture: string | null;
  };
  accountId: string;
  accountName: string | null;
  accessToken: string;
  refreshToken?: string;
  accessTokenExpiresAt?: number;
  grantedCapabilities: CloudflareConnectionRequest['requestedCapabilities'];
};

export interface CloudflareOrchestrator {
  startConnection(request: CloudflareConnectionRequest): Promise<CloudflareConnectionChallenge>;
  completeConnection(request: CloudflareConnectionCompletionRequest): Promise<CloudflareConnectionResult>;
}

export class CloudflareOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudflareOAuthError';
  }
}

export class CloudflareOrchestratorUnavailableError extends Error {
  constructor() {
    super('Cloudflare account provisioning is not configured for this environment.');
    this.name = 'CloudflareOrchestratorUnavailableError';
  }
}

/** Fail closed when neither public OAuth nor a future partner adapter is configured. */
export class UnavailableCloudflareOrchestrator implements CloudflareOrchestrator {
  async startConnection(_request: CloudflareConnectionRequest): Promise<CloudflareConnectionChallenge> {
    throw new CloudflareOrchestratorUnavailableError();
  }

  async completeConnection(_request: CloudflareConnectionCompletionRequest): Promise<CloudflareConnectionResult> {
    throw new CloudflareOrchestratorUnavailableError();
  }
}

export async function createCloudflareOrchestrator(env: Env): Promise<CloudflareOrchestrator> {
  if (env.CLOUDFLARE_OAUTH_CLIENT_ID && env.CLOUDFLARE_OAUTH_CLIENT_SECRET && env.CLOUDFLARE_OAUTH_SCOPES) {
    const { CloudflareOAuthOrchestrator } = await import('./cloudflare-oauth-orchestrator');
    return new CloudflareOAuthOrchestrator({
      clientId: env.CLOUDFLARE_OAUTH_CLIENT_ID,
      clientSecret: env.CLOUDFLARE_OAUTH_CLIENT_SECRET,
      scopes: env.CLOUDFLARE_OAUTH_SCOPES,
    });
  }
  return new UnavailableCloudflareOrchestrator();
}
