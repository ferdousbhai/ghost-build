import type {
  CloudflareConnectionChallenge,
  CloudflareConnectionCompletionRequest,
  CloudflareConnectionRequest,
  CloudflareConnectionResult,
  CloudflareOrchestrator,
} from './cloudflare-orchestrator';

const AUTHORIZE_URL = 'https://dash.cloudflare.com/oauth2/auth';
const TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token';
const ACCOUNTS_URL = 'https://api.cloudflare.com/client/v4/accounts?per_page=2';
const SESSION_LIFETIME_MS = 10 * 60 * 1000;
export const REQUIRED_CLOUDFLARE_OAUTH_SCOPES = [
  'account-settings.read',
  'workers-scripts.write',
  'd1.write',
  'workers-r2.write',
  'ai.read',
] as const;

type OAuthSession = {
  verifier: string;
  redirectUri: string;
  capabilities: CloudflareConnectionRequest['requestedCapabilities'];
};

export class CloudflareOAuthOrchestrator implements CloudflareOrchestrator {
  constructor(
    private readonly config: { clientId: string; clientSecret: string; scopes: string },
    private readonly request: typeof fetch = fetch,
  ) {}

  async startConnection(request: CloudflareConnectionRequest): Promise<CloudflareConnectionChallenge> {
    const configuredScopes = new Set(this.config.scopes.split(/\s+/).filter(Boolean));
    const missingScopes = REQUIRED_CLOUDFLARE_OAUTH_SCOPES.filter((scope) => !configuredScopes.has(scope));
    if (missingScopes.length > 0) {
      throw new CloudflareOAuthError(`Cloudflare OAuth is missing required scopes: ${missingScopes.join(', ')}.`);
    }
    const returnUrl = new URL(request.returnUrl);
    const state = returnUrl.searchParams.get('state');
    if (!state) {
      throw new CloudflareOAuthError('Cloudflare OAuth state is missing.');
    }
    returnUrl.search = '';
    const verifier = randomBase64Url(48);
    const challenge = base64Url(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
    );
    const authorizationUrl = new URL(AUTHORIZE_URL);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('response_mode', 'form_post');
    authorizationUrl.searchParams.set('client_id', this.config.clientId);
    authorizationUrl.searchParams.set('redirect_uri', returnUrl.toString());
    authorizationUrl.searchParams.set('scope', this.config.scopes);
    authorizationUrl.searchParams.set('state', state);
    authorizationUrl.searchParams.set('code_challenge', challenge);
    authorizationUrl.searchParams.set('code_challenge_method', 'S256');
    return {
      sessionId: JSON.stringify({
        verifier,
        redirectUri: returnUrl.toString(),
        capabilities: request.requestedCapabilities,
      } satisfies OAuthSession),
      authorizationUrl: authorizationUrl.toString(),
      expiresAt: Date.now() + SESSION_LIFETIME_MS,
    };
  }

  async completeConnection(request: CloudflareConnectionCompletionRequest): Promise<CloudflareConnectionResult> {
    const execute = this.request;
    const session = parseSession(request.providerSessionId);
    const callback = new URL(request.callbackUrl);
    const providerError = callback.searchParams.get('error');
    if (providerError) {
      throw new CloudflareOAuthError('Cloudflare authorization was declined or could not be completed.');
    }
    const code = callback.searchParams.get('code');
    if (!code) {
      throw new CloudflareOAuthError('Cloudflare authorization code is missing.');
    }
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.config.clientId,
      code,
      redirect_uri: session.redirectUri,
      code_verifier: session.verifier,
    });
    const tokenResponse = await execute(TOKEN_URL, {
      method: 'POST',
      headers: {
        authorization: `Basic ${btoa(`${this.config.clientId}:${this.config.clientSecret}`)}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form,
    });
    const token = (await tokenResponse.json().catch(() => null)) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    } | null;
    if (!tokenResponse.ok || !token?.access_token) {
      throw new CloudflareOAuthError('Cloudflare token exchange failed.');
    }
    if (!token.refresh_token) {
      throw new CloudflareOAuthError(
        'Cloudflare did not issue a refresh token. Reconnect with offline access enabled.',
      );
    }
    const accountsResponse = await execute(ACCOUNTS_URL, {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    const accountsPayload = (await accountsResponse.json().catch(() => null)) as {
      success?: boolean;
      result?: Array<{ id?: string; name?: string }>;
    } | null;
    const accounts = accountsPayload?.result ?? [];
    if (!accountsResponse.ok || accountsPayload?.success !== true || accounts.length !== 1) {
      throw new CloudflareOAuthError('Select exactly one Cloudflare account when authorizing Ghostbuild.');
    }
    const account = accounts[0];
    if (!account.id) {
      throw new CloudflareOAuthError('Cloudflare did not return an authorized account.');
    }
    return {
      accountId: account.id,
      accountName: account.name ?? null,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      accessTokenExpiresAt:
        typeof token.expires_in === 'number' ? Date.now() + Math.max(0, token.expires_in) * 1_000 : undefined,
      grantedCapabilities: session.capabilities,
    };
  }
}

export class CloudflareOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudflareOAuthError';
  }
}

function parseSession(value: string): OAuthSession {
  try {
    const parsed = JSON.parse(value) as Partial<OAuthSession>;
    if (
      typeof parsed.verifier !== 'string' ||
      typeof parsed.redirectUri !== 'string' ||
      !Array.isArray(parsed.capabilities)
    ) {
      throw new Error();
    }
    return parsed as OAuthSession;
  } catch {
    throw new CloudflareOAuthError('Cloudflare OAuth session is invalid.');
  }
}

function randomBase64Url(bytes: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
