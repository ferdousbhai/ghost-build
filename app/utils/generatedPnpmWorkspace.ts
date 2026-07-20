import { isAlias, isMap, isScalar, isSeq, parseDocument, visit } from 'yaml';

const MAX_PNPM_WORKSPACE_POLICY_BYTES = 64 * 1024;
const APPROVED_GENERATED_BUILD_DEPENDENCIES = ['core-js-pure', 'esbuild', 'sharp', 'workerd'] as const;
const ALLOWED_POLICY_KEYS = new Set([
  'packages',
  'ignoreWorkspaceRootCheck',
  'minimumReleaseAge',
  'minimumReleaseAgeIgnoreMissingTime',
  'minimumReleaseAgeStrict',
  'strictDepBuilds',
  'blockExoticSubdeps',
  'allowBuilds',
  'peerDependencyRules',
]);
const FORBIDDEN_POLICY_KEYS = new Set(['dangerouslyAllowAllBuilds', 'trustLockfile', 'minimumReleaseAgeExclude']);

export function assertSafeGeneratedPnpmWorkspace(filePath: string, content: string): void {
  const normalizedPath = filePath.replaceAll('\\', '/').replace(/^\.\/+/, '');
  if (normalizedPath !== 'pnpm-workspace.yaml') {
    return;
  }
  const errors = findGeneratedPnpmWorkspacePolicyErrors(content, 'Generated pnpm-workspace.yaml');
  if (errors.length > 0) {
    throw new Error(errors.join(' '));
  }
}

function findGeneratedPnpmWorkspacePolicyErrors(content: string, label: string): string[] {
  if (exceedsPolicySizeLimit(content)) {
    return [`${label} must not exceed ${MAX_PNPM_WORKSPACE_POLICY_BYTES} UTF-8 bytes.`];
  }
  const document = parseDocument(content, { uniqueKeys: true });
  const errors = document.errors.map((error) => `${label} must be unambiguous YAML: ${error.message}`);
  if (errors.length > 0) {
    return errors;
  }

  let containsUnsafeNode = false;
  visit(document, (_key, node) => {
    if (isAlias(node) || hasYamlMetadata(node)) {
      containsUnsafeNode = true;
      return visit.BREAK;
    }
    return undefined;
  });
  if (containsUnsafeNode) {
    errors.push(`${label} must not use YAML anchors, aliases, or explicit tags.`);
  }

  const root = document.contents;
  if (!isMap(root)) {
    return [...errors, `${label} must contain a top-level mapping.`];
  }
  if (root.flow) {
    errors.push(`${label} must use a top-level block mapping.`);
  }

  for (const pair of root.items) {
    const canonicalKey =
      isScalar(pair.key) && typeof pair.key.value === 'string' && pair.key.type === 'PLAIN'
        ? pair.key.value
        : undefined;
    const key = isScalar(pair.key) && typeof pair.key.value === 'string' ? pair.key.value : undefined;
    if (!canonicalKey) {
      errors.push(`${label} top-level keys must be canonical plain strings.`);
    }
    if (key && FORBIDDEN_POLICY_KEYS.has(key)) {
      errors.push(`${label} must not define ${key}.`);
    } else if (key && !ALLOWED_POLICY_KEYS.has(key)) {
      errors.push(`${label} must not define unexpected setting ${key}.`);
    }
  }

  requirePlainScalar(root, 'minimumReleaseAge', 1440, `${label} must set minimumReleaseAge to 1440 minutes.`, errors);
  requirePlainScalar(root, 'ignoreWorkspaceRootCheck', true, `${label} must enable ignoreWorkspaceRootCheck.`, errors);
  requirePlainScalar(
    root,
    'minimumReleaseAgeIgnoreMissingTime',
    false,
    `${label} must disable minimumReleaseAgeIgnoreMissingTime.`,
    errors,
  );
  requirePlainScalar(root, 'minimumReleaseAgeStrict', true, `${label} must enable minimumReleaseAgeStrict.`, errors);
  requirePlainScalar(root, 'strictDepBuilds', true, `${label} must enable strictDepBuilds.`, errors);
  requirePlainScalar(root, 'blockExoticSubdeps', true, `${label} must enable blockExoticSubdeps.`, errors);

  const packagesPair = root.items.find((pair) => isScalar(pair.key) && pair.key.value === 'packages');
  const packages = packagesPair?.value;
  if (
    !isSeq(packages) ||
    packages.items.length !== 1 ||
    !isScalar(packages.items[0]) ||
    packages.items[0].value !== '.'
  ) {
    errors.push(`${label} must scope packages to the generated project root only.`);
  }

  const allowBuildsPair = root.items.find((pair) => isScalar(pair.key) && pair.key.value === 'allowBuilds');
  if (!allowBuildsPair || !isScalar(allowBuildsPair.key) || allowBuildsPair.key.type !== 'PLAIN') {
    errors.push(`${label} must define allowBuilds with a canonical plain key.`);
  }
  const allowBuilds = allowBuildsPair?.value;
  if (!isMap(allowBuilds)) {
    return [...errors, `${label} allowBuilds must be a mapping.`];
  }
  if (allowBuilds.flow) {
    errors.push(`${label} allowBuilds must use a block mapping.`);
  }

  const configured = new Set<string>();
  for (const pair of allowBuilds.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || pair.key.type !== 'PLAIN') {
      errors.push(`${label} allowBuilds keys must be plain package names.`);
      continue;
    }
    const dependency = pair.key.value;
    configured.add(dependency);
    if (!isScalar(pair.value) || pair.value.value !== true || pair.value.type !== 'PLAIN') {
      errors.push(`${label} allowBuilds.${dependency} must be boolean true.`);
    }
    if (!(APPROVED_GENERATED_BUILD_DEPENDENCIES as readonly string[]).includes(dependency)) {
      errors.push(`${label} allowBuilds must not approve unexpected package ${dependency}.`);
    }
  }
  for (const dependency of APPROVED_GENERATED_BUILD_DEPENDENCIES) {
    if (!configured.has(dependency)) {
      errors.push(`${label} allowBuilds must approve ${dependency}.`);
    }
  }
  return errors;
}

function exceedsPolicySizeLimit(content: string): boolean {
  return (
    content.length > MAX_PNPM_WORKSPACE_POLICY_BYTES ||
    new TextEncoder().encode(content).byteLength > MAX_PNPM_WORKSPACE_POLICY_BYTES
  );
}

function hasYamlMetadata(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (('anchor' in value && Boolean(value.anchor)) || ('tag' in value && Boolean(value.tag)))
  );
}

function requirePlainScalar(
  root: ReturnType<typeof parseDocument>['contents'],
  key: string,
  expected: number | boolean,
  error: string,
  errors: string[],
): void {
  if (!isMap(root)) {
    errors.push(error);
    return;
  }
  const pair = root.items.find((candidate) => isScalar(candidate.key) && candidate.key.value === key);
  if (
    !pair ||
    !isScalar(pair.key) ||
    pair.key.type !== 'PLAIN' ||
    !isScalar(pair.value) ||
    pair.value.type !== 'PLAIN' ||
    pair.value.value !== expected
  ) {
    errors.push(error);
  }
}
