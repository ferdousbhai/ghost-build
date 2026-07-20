import type { Deployment } from './deployment-repository';

const BUILD_ARTIFACT_VERSION = 2 as const;
const BUILD_ARTIFACT_PREFIX = 'deployment-builds';
const MAX_BUILD_ARTIFACT_BYTES = 50 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type DeploymentBuildReceipt = {
  version: typeof BUILD_ARTIFACT_VERSION;
  deploymentId: string;
  executionGeneration: number;
  planDigest: string;
  sourceSha256: string;
  objectKey: string;
  buildSha256: string;
  byteLength: number;
  receiptSha256: string;
};

export async function storeDeploymentBuildArtifact(args: {
  env: Pick<Env, 'APP_STORAGE'>;
  deployment: Deployment;
  build: Uint8Array<ArrayBuffer>;
}): Promise<DeploymentBuildReceipt> {
  validateDeploymentIdentity(args.deployment);
  if (args.build.byteLength < 1 || args.build.byteLength > MAX_BUILD_ARTIFACT_BYTES) {
    throw new DeploymentBuildArtifactError('Deployment build artifact has an invalid size.');
  }
  const buildSha256 = await sha256Hex(args.build);
  const receipt = await createReceipt({
    deploymentId: args.deployment.id,
    executionGeneration: args.deployment.executionGeneration,
    planDigest: args.deployment.planDigest,
    sourceSha256: args.deployment.plan.sourceSha256,
    objectKey: deploymentBuildArtifactKey(args.deployment),
    buildSha256,
    byteLength: args.build.byteLength,
  });
  try {
    const stored = await args.env.APP_STORAGE.put(receipt.objectKey, args.build, {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: 'application/gzip' },
      customMetadata: receiptMetadata(receipt),
      sha256: hexToBytes(buildSha256),
    });
    if (stored) {
      return receipt;
    }
  } catch (error) {
    const recovered = await recoverCompetingStore(args.env, args.deployment);
    if (recovered) {
      return recovered;
    }
    throw error;
  }
  const winner = await recoverCompetingStore(args.env, args.deployment);
  if (!winner) {
    throw new DeploymentBuildArtifactError('Deployment build artifact is unavailable after a concurrent store.');
  }
  return winner;
}

export async function loadDeploymentBuildArtifact(args: {
  env: Pick<Env, 'APP_STORAGE'>;
  deployment: Deployment;
  receipt: DeploymentBuildReceipt;
}): Promise<Uint8Array<ArrayBuffer>> {
  validateDeploymentIdentity(args.deployment);
  validateReceiptShape(args.receipt);
  const expectedReceipt = await createReceipt({
    deploymentId: args.deployment.id,
    executionGeneration: args.deployment.executionGeneration,
    planDigest: args.deployment.planDigest,
    sourceSha256: args.deployment.plan.sourceSha256,
    objectKey: deploymentBuildArtifactKey(args.deployment),
    buildSha256: args.receipt.buildSha256,
    byteLength: args.receipt.byteLength,
  });
  if (!receiptsEqual(args.receipt, expectedReceipt)) {
    throw new DeploymentBuildArtifactError('Deployment build receipt does not match the approved deployment.');
  }

  const object = await args.env.APP_STORAGE.get(expectedReceipt.objectKey);
  if (!object) {
    throw new DeploymentBuildArtifactError('Deployment build artifact is unavailable.');
  }
  if (object.size !== expectedReceipt.byteLength || object.size > MAX_BUILD_ARTIFACT_BYTES) {
    throw new DeploymentBuildArtifactError('Deployment build artifact size does not match its receipt.');
  }
  const metadata = receiptMetadata(expectedReceipt);
  if (Object.entries(metadata).some(([key, value]) => object.customMetadata?.[key] !== value)) {
    throw new DeploymentBuildArtifactError('Deployment build artifact metadata does not match its receipt.');
  }
  if (checksumHex(object.checksums.sha256) !== expectedReceipt.buildSha256) {
    throw new DeploymentBuildArtifactError('Deployment build artifact checksum does not match its receipt.');
  }
  const build = new Uint8Array(await object.arrayBuffer());
  if (build.byteLength !== expectedReceipt.byteLength || (await sha256Hex(build)) !== expectedReceipt.buildSha256) {
    throw new DeploymentBuildArtifactError('Deployment build artifact failed integrity verification.');
  }
  return build;
}

export async function readStoredDeploymentBuildReceipt(args: {
  env: Pick<Env, 'APP_STORAGE'>;
  deployment: Deployment;
}): Promise<DeploymentBuildReceipt | null> {
  validateDeploymentIdentity(args.deployment);
  const objectKey = deploymentBuildArtifactKey(args.deployment);
  const object = await args.env.APP_STORAGE.head(objectKey);
  if (!object) {
    return null;
  }
  const metadata = object.customMetadata;
  const receipt = {
    version: Number(metadata?.version),
    deploymentId: metadata?.deploymentId,
    executionGeneration: Number(metadata?.executionGeneration),
    planDigest: metadata?.planDigest,
    sourceSha256: metadata?.sourceSha256,
    objectKey,
    buildSha256: metadata?.buildSha256,
    byteLength: Number(metadata?.byteLength),
    receiptSha256: metadata?.receiptSha256,
  } as DeploymentBuildReceipt;
  validateReceiptShape(receipt);
  const expected = await createReceipt({
    deploymentId: args.deployment.id,
    executionGeneration: args.deployment.executionGeneration,
    planDigest: args.deployment.planDigest,
    sourceSha256: args.deployment.plan.sourceSha256,
    objectKey,
    buildSha256: receipt.buildSha256,
    byteLength: receipt.byteLength,
  });
  if (
    !receiptsEqual(receipt, expected) ||
    object.size !== receipt.byteLength ||
    checksumHex(object.checksums.sha256) !== receipt.buildSha256
  ) {
    throw new DeploymentBuildArtifactError('Stored deployment build artifact does not match its receipt.');
  }
  return receipt;
}

export function deploymentBuildArtifactKey(deployment: Deployment): string {
  validateDeploymentIdentity(deployment);
  return (
    `${BUILD_ARTIFACT_PREFIX}/${encodeURIComponent(deployment.id)}/` +
    `execution-${deployment.executionGeneration}/` +
    `${deployment.planDigest}-${deployment.plan.sourceSha256}.tar.gz`
  );
}

function validateDeploymentIdentity(deployment: Deployment): void {
  if (
    !deployment.id ||
    deployment.id.length > 200 ||
    deployment.plan.deploymentId !== deployment.id ||
    !Number.isSafeInteger(deployment.executionGeneration) ||
    deployment.executionGeneration < 1 ||
    !SHA256_PATTERN.test(deployment.planDigest) ||
    !SHA256_PATTERN.test(deployment.plan.sourceSha256) ||
    deployment.approvedDigest !== deployment.planDigest
  ) {
    throw new DeploymentBuildArtifactError('Approved deployment identity is invalid.');
  }
}

function validateReceiptShape(receipt: DeploymentBuildReceipt): void {
  if (
    !receipt ||
    receipt.version !== BUILD_ARTIFACT_VERSION ||
    typeof receipt.deploymentId !== 'string' ||
    !Number.isSafeInteger(receipt.executionGeneration) ||
    receipt.executionGeneration < 1 ||
    typeof receipt.planDigest !== 'string' ||
    typeof receipt.sourceSha256 !== 'string' ||
    typeof receipt.objectKey !== 'string' ||
    typeof receipt.buildSha256 !== 'string' ||
    !Number.isSafeInteger(receipt.byteLength) ||
    receipt.byteLength < 1 ||
    receipt.byteLength > MAX_BUILD_ARTIFACT_BYTES ||
    typeof receipt.receiptSha256 !== 'string' ||
    !SHA256_PATTERN.test(receipt.planDigest) ||
    !SHA256_PATTERN.test(receipt.sourceSha256) ||
    !SHA256_PATTERN.test(receipt.buildSha256) ||
    !SHA256_PATTERN.test(receipt.receiptSha256)
  ) {
    throw new DeploymentBuildArtifactError('Deployment build receipt is invalid.');
  }
}

async function createReceipt(
  value: Omit<DeploymentBuildReceipt, 'version' | 'receiptSha256'>,
): Promise<DeploymentBuildReceipt> {
  const payload = { version: BUILD_ARTIFACT_VERSION, ...value };
  return {
    ...payload,
    receiptSha256: await sha256Hex(new TextEncoder().encode(JSON.stringify(payload))),
  };
}

function receiptMetadata(receipt: DeploymentBuildReceipt): Record<string, string> {
  return {
    version: String(receipt.version),
    deploymentId: receipt.deploymentId,
    executionGeneration: String(receipt.executionGeneration),
    planDigest: receipt.planDigest,
    sourceSha256: receipt.sourceSha256,
    buildSha256: receipt.buildSha256,
    byteLength: String(receipt.byteLength),
    receiptSha256: receipt.receiptSha256,
  };
}

function receiptsEqual(left: DeploymentBuildReceipt, right: DeploymentBuildReceipt): boolean {
  return (
    left.version === right.version &&
    left.deploymentId === right.deploymentId &&
    left.executionGeneration === right.executionGeneration &&
    left.planDigest === right.planDigest &&
    left.sourceSha256 === right.sourceSha256 &&
    left.objectKey === right.objectKey &&
    left.buildSha256 === right.buildSha256 &&
    left.byteLength === right.byteLength &&
    left.receiptSha256 === right.receiptSha256
  );
}

async function recoverCompetingStore(
  env: Pick<Env, 'APP_STORAGE'>,
  deployment: Deployment,
): Promise<DeploymentBuildReceipt | null> {
  try {
    return await readStoredDeploymentBuildReceipt({ env, deployment });
  } catch (error) {
    if (error instanceof DeploymentBuildArtifactError) {
      return null;
    }
    throw error;
  }
}

async function sha256Hex(value: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', value);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

function checksumHex(value: ArrayBuffer | undefined): string | null {
  return value ? Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('') : null;
}

export class DeploymentBuildArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeploymentBuildArtifactError';
  }
}
