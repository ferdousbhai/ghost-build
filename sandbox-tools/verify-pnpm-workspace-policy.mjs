#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isAlias, isMap, isScalar, isSeq, parseDocument, visit } from 'yaml';

const APPROVED_BUILD_DEPENDENCIES = new Set(['core-js-pure', 'esbuild', 'sharp', 'workerd']);
const MAX_PNPM_WORKSPACE_POLICY_BYTES = 64 * 1024;
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

export function findWorkspacePolicyErrors(source, approvedBuildDependencies = APPROVED_BUILD_DEPENDENCIES) {
  if (exceedsPolicySizeLimit(source)) {
    return [`pnpm-workspace.yaml must not exceed ${MAX_PNPM_WORKSPACE_POLICY_BYTES} UTF-8 bytes.`];
  }

  const document = parseDocument(source, { uniqueKeys: true });
  const errors = document.errors.map((error) => `pnpm-workspace.yaml must be unambiguous YAML: ${error.message}`);

  if (errors.length > 0) {
    return errors;
  }

  let containsNonCanonicalYaml = false;
  visit(document, (_key, node) => {
    if (isAlias(node) || node.anchor || node.tag) {
      containsNonCanonicalYaml = true;
      return visit.BREAK;
    }

    return undefined;
  });

  if (containsNonCanonicalYaml) {
    errors.push('pnpm-workspace.yaml must not use YAML anchors, aliases, or explicit tags.');
  }

  const root = document.contents;

  if (!isMap(root)) {
    return [...errors, 'pnpm-workspace.yaml must contain a top-level mapping.'];
  }

  if (root.flow) {
    errors.push('pnpm-workspace.yaml must use a top-level block mapping.');
  }

  for (const pair of root.items) {
    const key = isScalar(pair.key) && typeof pair.key.value === 'string' ? pair.key.value : undefined;
    if (!key || pair.key.type !== 'PLAIN') {
      errors.push('pnpm-workspace.yaml top-level keys must be canonical plain strings.');
    }
    if (key && FORBIDDEN_POLICY_KEYS.has(key)) {
      errors.push(`pnpm-workspace.yaml must not define ${key}.`);
    } else if (key && !ALLOWED_POLICY_KEYS.has(key)) {
      errors.push(`pnpm-workspace.yaml must not define unexpected setting ${key}.`);
    }
  }

  const minimumReleaseAgePair = plainPair(root, 'minimumReleaseAge');
  const minimumReleaseAge = minimumReleaseAgePair?.value;

  if (!isScalar(minimumReleaseAge) || minimumReleaseAge.value !== 1440) {
    errors.push('pnpm-workspace.yaml must set minimumReleaseAge to 1440 minutes.');
  }

  const ignoreWorkspaceRootCheckPair = plainPair(root, 'ignoreWorkspaceRootCheck');
  const ignoreWorkspaceRootCheck = ignoreWorkspaceRootCheckPair?.value;

  if (!isScalar(ignoreWorkspaceRootCheck) || ignoreWorkspaceRootCheck.value !== true) {
    errors.push('pnpm-workspace.yaml must set ignoreWorkspaceRootCheck to boolean true.');
  }

  const packagesPair = plainPair(root, 'packages');
  const packages = packagesPair?.value;

  if (!isSeq(packages)) {
    errors.push('pnpm-workspace.yaml packages must be a sequence.');
  } else {
    for (const entry of packages.items) {
      if (!isScalar(entry) || typeof entry.value !== 'string' || !isSafeWorkspacePackagePattern(entry.value)) {
        errors.push('pnpm-workspace.yaml packages must contain only in-tree relative workspace patterns.');
      }
    }
  }

  const minimumReleaseAgeIgnoreMissingTimePair = plainPair(root, 'minimumReleaseAgeIgnoreMissingTime');
  const minimumReleaseAgeIgnoreMissingTime = minimumReleaseAgeIgnoreMissingTimePair?.value;

  if (!isScalar(minimumReleaseAgeIgnoreMissingTime) || minimumReleaseAgeIgnoreMissingTime.value !== false) {
    errors.push('pnpm-workspace.yaml must set minimumReleaseAgeIgnoreMissingTime to boolean false.');
  }

  const minimumReleaseAgeStrictPair = plainPair(root, 'minimumReleaseAgeStrict');
  const minimumReleaseAgeStrict = minimumReleaseAgeStrictPair?.value;

  if (!isScalar(minimumReleaseAgeStrict) || minimumReleaseAgeStrict.value !== true) {
    errors.push('pnpm-workspace.yaml must set minimumReleaseAgeStrict to boolean true.');
  }

  const strictDepBuildsPair = plainPair(root, 'strictDepBuilds');
  const strictDepBuilds = strictDepBuildsPair?.value;

  if (!isScalar(strictDepBuilds) || strictDepBuilds.value !== true) {
    errors.push('pnpm-workspace.yaml must set strictDepBuilds to boolean true.');
  }

  const blockExoticSubdepsPair = plainPair(root, 'blockExoticSubdeps');
  const blockExoticSubdeps = blockExoticSubdepsPair?.value;

  if (!isScalar(blockExoticSubdeps) || blockExoticSubdeps.value !== true) {
    errors.push('pnpm-workspace.yaml must set blockExoticSubdeps to boolean true.');
  }

  const allowBuildsPair = plainPair(root, 'allowBuilds');
  const allowBuilds = allowBuildsPair?.value;

  if (!isMap(allowBuilds)) {
    return [...errors, 'pnpm-workspace.yaml allowBuilds must be a mapping.'];
  }

  if (allowBuilds.flow) {
    errors.push('pnpm-workspace.yaml allowBuilds must use a block mapping.');
  }

  const configured = new Set();
  const approved = new Set(approvedBuildDependencies);

  for (const pair of allowBuilds.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || pair.key.type !== 'PLAIN') {
      errors.push('pnpm-workspace.yaml allowBuilds keys must be plain package names.');
      continue;
    }

    const dependency = pair.key.value;
    configured.add(dependency);

    if (!isScalar(pair.value) || pair.value.value !== true) {
      errors.push(`pnpm-workspace.yaml allowBuilds.${dependency} must be boolean true.`);
    }

    if (!approved.has(dependency)) {
      errors.push(`pnpm-workspace.yaml allowBuilds must not approve unexpected package ${dependency}.`);
    }
  }

  for (const dependency of approved) {
    if (!configured.has(dependency)) {
      errors.push(`pnpm-workspace.yaml allowBuilds must approve ${dependency}.`);
    }
  }

  return errors;
}

function exceedsPolicySizeLimit(content) {
  return (
    content.length > MAX_PNPM_WORKSPACE_POLICY_BYTES ||
    new TextEncoder().encode(content).byteLength > MAX_PNPM_WORKSPACE_POLICY_BYTES
  );
}

function plainPair(map, key) {
  return map.items.find((pair) => isScalar(pair.key) && pair.key.value === key && pair.key.type === 'PLAIN');
}

function isSafeWorkspacePackagePattern(pattern) {
  if (pattern.length === 0 || pattern.trim() !== pattern || /[\0-\x1f\x7f]/u.test(pattern)) {
    return false;
  }

  const normalized = pattern.startsWith('!') ? pattern.slice(1) : pattern;
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    normalized.startsWith('\\') ||
    normalized.startsWith('~') ||
    normalized.includes('\\') ||
    /^[a-z]:/iu.test(normalized) ||
    /^[a-z][a-z\d+.-]*:/iu.test(normalized) ||
    !/^[a-z\d@._*?/-]+$/iu.test(normalized)
  ) {
    return false;
  }

  return normalized.split('/').every((segment) => segment.length > 0 && !segment.includes('..'));
}

export function main(path = process.argv[2] ?? 'pnpm-workspace.yaml') {
  const errors = findWorkspacePolicyErrors(readFileSync(path, 'utf8'));

  if (errors.length > 0) {
    console.error(errors.map((error) => `- ${error}`).join('\n'));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
