const TOKEN_AUDIENCE = 'ghostbuild-cloudflare-deployment-proxy';
const MAX_TOKEN_LIFETIME_SECONDS = 15 * 60;
const DEPLOYMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLISH_CONTAINER_PATTERN = /^p-([0-9a-f]{32})-([0-9a-z]+)-([0-9a-z]+)$/;

type DeploymentProxyClaims = {
  aud: typeof TOKEN_AUDIENCE;
  deploymentId: string;
  accountId: string;
  connectionGeneration: number;
  executionGeneration: number;
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
  connectionGeneration: number;
  executionGeneration: number;
  planDigest: string;
  containerId: string;
  nowSeconds?: number;
  lifetimeSeconds?: number;
}): Promise<string> {
  if (!isPositiveSafeInteger(args.connectionGeneration) || !isPositiveSafeInteger(args.executionGeneration)) {
    throw new Error('Deployment proxy token generation is invalid.');
  }
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
    connectionGeneration: args.connectionGeneration,
    executionGeneration: args.executionGeneration,
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

export function deploymentPublishContainerId(args: {
  deploymentId: string;
  connectionGeneration: number;
  executionGeneration: number;
}): string {
  if (
    !DEPLOYMENT_ID_PATTERN.test(args.deploymentId) ||
    !isPositiveSafeInteger(args.connectionGeneration) ||
    !isPositiveSafeInteger(args.executionGeneration)
  ) {
    throw new Error('Deployment publish container generation is invalid.');
  }
  return (
    `p-${args.deploymentId.replaceAll('-', '')}-` +
    `${args.connectionGeneration.toString(36)}-${args.executionGeneration.toString(36)}`
  ).toLowerCase();
}

export function parseDeploymentPublishContainerId(containerId: string): {
  deploymentId: string;
  connectionGeneration: number;
  executionGeneration: number;
} | null {
  const match = PUBLISH_CONTAINER_PATTERN.exec(containerId);
  if (!match) {
    return null;
  }
  const connectionGeneration = Number.parseInt(match[2], 36);
  const executionGeneration = Number.parseInt(match[3], 36);
  if (!isPositiveSafeInteger(connectionGeneration) || !isPositiveSafeInteger(executionGeneration)) {
    return null;
  }
  return {
    deploymentId: restoreDeploymentId(match[1]),
    connectionGeneration,
    executionGeneration,
  };
}

function restoreDeploymentId(compact: string): string {
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
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
    isPositiveSafeInteger(value.connectionGeneration) &&
    isPositiveSafeInteger(value.executionGeneration) &&
    typeof value.planDigest === 'string' &&
    typeof value.containerId === 'string' &&
    typeof value.iat === 'number' &&
    typeof value.exp === 'number' &&
    typeof value.jti === 'string'
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
