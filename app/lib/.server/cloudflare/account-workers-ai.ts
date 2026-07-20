import { requireActiveCloudflareConnection } from './cloudflare-connection-repository';

export interface CloudflareCredentialResolver {
  resolve(credentialHandle: string): Promise<string>;
}

type RunAccountWorkersAiOptions = {
  db: D1Database;
  connectionId: string;
  credentialResolver: CloudflareCredentialResolver;
  model: string;
  input: unknown;
  fetch?: typeof globalThis.fetch;
};

export async function runAccountWorkersAi(options: RunAccountWorkersAiOptions): Promise<Response> {
  const connection = await requireActiveCloudflareConnection(options.db, options.connectionId);
  if (!connection.aiBillingEnabled) {
    throw new Error('Workers AI billing is not enabled for this Cloudflare connection.');
  }
  if (!connection.credentialHandle) {
    throw new Error('The Cloudflare connection has no credential handle.');
  }

  const token = await options.credentialResolver.resolve(connection.credentialHandle);
  const execute = options.fetch ?? globalThis.fetch;
  const endpoint = new URL(
    `/client/v4/accounts/${encodeURIComponent(connection.accountId)}/ai/run/${encodeModelPath(options.model)}`,
    'https://api.cloudflare.com',
  );
  const response = await execute(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(options.input),
  });

  if (!response.ok) {
    throw new Error(`Cloudflare Workers AI request failed with status ${response.status}.`);
  }
  return response;
}

function encodeModelPath(model: string): string {
  if (!model.startsWith('@cf/')) {
    throw new Error('Ghostbuild only supports Cloudflare-hosted Workers AI models.');
  }
  return model
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}
