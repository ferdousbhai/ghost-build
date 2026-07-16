const TOKEN_AUDIENCE = 'ghostbuild-cloudflare-deployment-proxy';
const MAX_TOKEN_LIFETIME_SECONDS = 15 * 60;

type DeploymentProxyClaims = {
  aud: typeof TOKEN_AUDIENCE;
  deploymentId: string;
  accountId: string;
  planDigest: string;
  containerId: string;
  iat: number;
  exp: number;
  jti: string;
};

export async function createDeploymentProxyToken(args: {
  secretBase64: string;
  deploymentId: string;
  accountId: string;
  planDigest: string;
  containerId: string;
  nowSeconds?: number;
  lifetimeSeconds?: number;
}): Promise<string> {
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  const lifetime = args.lifetimeSeconds ?? MAX_TOKEN_LIFETIME_SECONDS;
  if (!Number.isInteger(lifetime) || lifetime <= 0 || lifetime > MAX_TOKEN_LIFETIME_SECONDS) {
    throw new Error('Deployment proxy token lifetime is invalid.');
  }
  const header = encodeJson({ alg: 'HS256', typ: 'JWT' });
  const payload = encodeJson({
    aud: TOKEN_AUDIENCE,
    deploymentId: args.deploymentId,
    accountId: args.accountId,
    planDigest: args.planDigest,
    containerId: args.containerId,
    iat: now,
    exp: now + lifetime,
    jti: crypto.randomUUID(),
  } satisfies DeploymentProxyClaims);
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${await sign(unsigned, args.secretBase64)}`;
}

export async function verifyDeploymentProxyToken(args: {
  token: string;
  secretBase64: string;
  expectedContainerId: string;
  nowSeconds?: number;
}): Promise<DeploymentProxyClaims> {
  const parts = args.token.split('.');
  if (parts.length !== 3) {
    throw new DeploymentProxyTokenError();
  }
  const [headerPart, payloadPart, signaturePart] = parts;
  const expectedSignature = await sign(`${headerPart}.${payloadPart}`, args.secretBase64);
  if (!constantTimeEqual(signaturePart, expectedSignature)) {
    throw new DeploymentProxyTokenError();
  }
  const header = decodeJson(headerPart);
  const claims = decodeJson(payloadPart);
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (
    !isRecord(header) ||
    header.alg !== 'HS256' ||
    header.typ !== 'JWT' ||
    !isDeploymentProxyClaims(claims) ||
    claims.aud !== TOKEN_AUDIENCE ||
    claims.containerId !== args.expectedContainerId ||
    claims.exp <= now ||
    claims.iat > now + 30 ||
    claims.exp - claims.iat > MAX_TOKEN_LIFETIME_SECONDS
  ) {
    throw new DeploymentProxyTokenError();
  }
  return claims;
}

export class DeploymentProxyTokenError extends Error {
  constructor() {
    super('Deployment proxy authorization is invalid or expired.');
    this.name = 'DeploymentProxyTokenError';
  }
}

async function sign(value: string, secretBase64: string): Promise<string> {
  const secret = decodeBase64(secretBase64);
  if (secret.byteLength < 32) {
    throw new Error('DEPLOYMENT_PROXY_JWT_SECRET must contain at least 32 bytes.');
  }
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return encodeBase64Url(new Uint8Array(signature));
}

function encodeJson(value: unknown): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeJson(value: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as unknown;
  } catch {
    throw new DeploymentProxyTokenError();
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function decodeBase64Url(value: string): Uint8Array {
  return decodeBase64(value.replace(/-/g, '+').replace(/_/g, '/'));
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  try {
    const padded = value.padEnd(Math.ceil(value.length / 4) * 4, '=');
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    throw new DeploymentProxyTokenError();
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDeploymentProxyClaims(value: unknown): value is DeploymentProxyClaims {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.aud === 'string' &&
    typeof value.deploymentId === 'string' &&
    typeof value.accountId === 'string' &&
    typeof value.planDigest === 'string' &&
    typeof value.containerId === 'string' &&
    typeof value.iat === 'number' &&
    typeof value.exp === 'number' &&
    typeof value.jti === 'string'
  );
}
