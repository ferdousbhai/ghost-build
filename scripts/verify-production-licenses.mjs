import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const policyPath = resolve(rootDir, 'scripts/production-license-policy.json');
const lockfilePath = resolve(rootDir, 'pnpm-lock.yaml');
const noticeArtifactPath = resolve(rootDir, 'public/THIRD_PARTY_LICENSES.txt');
const nodeModulesPath = resolve(rootDir, 'node_modules');
const licenseFilePattern = /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i;
const readmeFilePattern = /^readme(?:[._-].*)?$/i;
const licenseTextMarker =
  /(?:Permission is hereby granted|Apache License|ISC License|Mozilla Public License|Redistribution and use in source and binary forms|Creative Commons Attribution|Python Software Foundation License|The Unlicense|Blue Oak Model License)/i;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function packageIdentity(name, version) {
  return `${name}@${version}`;
}

function normalizedMetadataValue(value) {
  if (value === undefined || value === null || value === '') {
    return '<not published>';
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function assertPackagePath(packagePath) {
  const resolvedPath = resolve(packagePath);
  const relativePath = relative(nodeModulesPath, resolvedPath);
  if (
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    resolve(nodeModulesPath, relativePath) !== resolvedPath
  ) {
    throw new Error(`Production license inventory returned a path outside node_modules: ${packagePath}.`);
  }
  return resolvedPath;
}

export function isPlatformNeutralProductionPackage(metadata) {
  return ![metadata?.os, metadata?.cpu, metadata?.libc].some(
    (value) => (Array.isArray(value) && value.length > 0) || (typeof value === 'string' && value.length > 0),
  );
}

function walkPackageFiles(directory, packageRoot, matches, depth = 0) {
  if (depth > 12) {
    throw new Error(
      `Production package notice traversal exceeded its depth limit in ${relative(packageRoot, directory)}.`,
    );
  }
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      walkPackageFiles(path, packageRoot, matches, depth + 1);
    } else if (entry.isFile() && licenseFilePattern.test(entry.name)) {
      matches.push(path);
    }
  }
}

function walkReadmeLicenseFallbacks(directory, packageRoot, matches, depth = 0) {
  if (depth > 12) {
    return;
  }
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      walkReadmeLicenseFallbacks(path, packageRoot, matches, depth + 1);
    } else if (entry.isFile() && readmeFilePattern.test(entry.name)) {
      const content = readFileSync(path);
      if (content.length <= 2 * 1024 * 1024 && licenseTextMarker.test(content.toString('utf8'))) {
        matches.push(path);
      }
    }
  }
}

function readExactTextFile(path, packageId) {
  const bytes = readFileSync(path);
  const content = bytes.toString('utf8');
  if (!Buffer.from(content, 'utf8').equals(bytes)) {
    throw new Error(`${packageId} publishes a non-UTF-8 license or notice file at ${path}.`);
  }
  return content;
}

function collectPackageLicenseFiles(packagePath, packageId) {
  const licenseMatches = [];
  walkPackageFiles(packagePath, packagePath, licenseMatches);
  const hasTopLevelLicense = licenseMatches.some((path) => !relative(packagePath, path).includes(sep));
  const readmeMatches = [];
  if (!hasTopLevelLicense) {
    walkReadmeLicenseFallbacks(packagePath, packagePath, readmeMatches);
  }
  const hasTopLevelReadmeLicense = readmeMatches.some((path) => !relative(packagePath, path).includes(sep));
  const files = [...new Set([...licenseMatches, ...readmeMatches])]
    .sort((left, right) => relative(packagePath, left).localeCompare(relative(packagePath, right)))
    .map((path) => ({
      path: relative(packagePath, path).split(sep).join('/'),
      content: readExactTextFile(path, packageId),
    }));
  return { files, hasPackageLicenseEvidence: hasTopLevelLicense || hasTopLevelReadmeLicense };
}

export function readNoticePackages(report) {
  const packages = [];
  for (const [reportedLicense, entries] of Object.entries(report ?? {})) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (
        !Array.isArray(entry?.versions) ||
        !Array.isArray(entry?.paths) ||
        entry.versions.length !== entry.paths.length
      ) {
        throw new Error(`pnpm returned mismatched versions and package paths for ${entry?.name ?? '<unknown>'}.`);
      }
      for (let index = 0; index < entry.versions.length; index += 1) {
        const version = entry.versions[index];
        const packagePath = assertPackagePath(entry.paths[index]);
        const metadata = JSON.parse(readFileSync(join(packagePath, 'package.json'), 'utf8'));
        const packageId = packageIdentity(entry.name, version);
        if (metadata.name !== entry.name || metadata.version !== version) {
          throw new Error(`${packageId} does not match the package metadata installed at ${packagePath}.`);
        }
        // OS/CPU/libc-restricted optional binaries are local build-tool
        // implementations. They are neither bundled into nor distributed with
        // the platform-neutral Worker/client release, and including the host's
        // selected binary would make the checked-in artifact platform-specific.
        if (!isPlatformNeutralProductionPackage(metadata)) {
          continue;
        }
        const licenseEvidence = collectPackageLicenseFiles(packagePath, packageId);
        packages.push({
          name: entry.name,
          version,
          reportedLicense,
          packageLicense: metadata.license,
          author: metadata.author,
          repository: metadata.repository,
          homepage: metadata.homepage,
          licenseFiles: licenseEvidence.files,
          hasPackageLicenseEvidence: licenseEvidence.hasPackageLicenseEvidence,
        });
      }
    }
  }
  return packages.sort(
    (left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
  );
}

export function createThirdPartyLicenseArtifact(packages, policy, lockfileContent) {
  const textByDigest = new Map();
  const packageRecords = packages.map((entry) => {
    const files = entry.licenseFiles.map((file) => {
      const digest = sha256(file.content);
      const existing = textByDigest.get(digest);
      if (existing && existing.content !== file.content) {
        throw new Error(`SHA-256 collision while inventorying ${packageIdentity(entry.name, entry.version)}.`);
      }
      const use = `${packageIdentity(entry.name, entry.version)}:${file.path}`;
      if (existing) {
        existing.uses.push(use);
      } else {
        textByDigest.set(digest, { content: file.content, uses: [use] });
      }
      return { path: file.path, digest };
    });
    return {
      name: entry.name,
      version: entry.version,
      license: entry.reportedLicense,
      author: normalizedMetadataValue(entry.author),
      repository: normalizedMetadataValue(entry.repository),
      homepage: normalizedMetadataValue(entry.homepage),
      hasPackageLicenseEvidence: entry.hasPackageLicenseEvidence,
      files,
    };
  });
  const inventoryDigest = sha256(
    `${sha256(lockfileContent)}\n${JSON.stringify(
      packageRecords.map(({ name, version, license, files }) => [
        name,
        version,
        license,
        files.map(({ path, digest }) => [path, digest]),
      ]),
    )}`,
  );

  const lines = [
    'Ghostbuild Third-Party Production Dependency Licenses',
    '',
    'This generated artifact inventories every exact platform-neutral production package version.',
    'Published package license and notice files are reproduced verbatim and deduplicated by SHA-256.',
    'Host-restricted native build-tool binaries are excluded because they are not distributed in the Worker or client artifact.',
    'A package whose package-level evidence is <not published> remains exact-version allowlisted for legal review; nested component notices are still reproduced.',
    'This automated artifact supports diligence but does not replace legal review.',
    '',
    `Policy reviewed: ${policy.reviewedAt}`,
    `Production packages: ${packageRecords.length}`,
    `Inventory SHA-256: ${inventoryDigest}`,
    '',
    'PACKAGE INVENTORY',
    '=================',
  ];
  for (const entry of packageRecords) {
    lines.push(
      '',
      packageIdentity(entry.name, entry.version),
      `Declared license: ${entry.license}`,
      `Author: ${entry.author}`,
      `Repository: ${entry.repository}`,
      `Homepage: ${entry.homepage}`,
      `Package-level license evidence: ${entry.hasPackageLicenseEvidence ? 'published' : '<not published>'}`,
    );
    if (entry.files.length === 0) {
      lines.push('Published license/notice files: <not published>');
    } else {
      lines.push('Published license/notice files:');
      for (const file of entry.files) {
        lines.push(`- ${file.path} (SHA-256 ${file.digest})`);
      }
    }
  }

  lines.push('', 'VERBATIM LICENSE AND NOTICE TEXTS', '=================================', '');
  for (const [digest, entry] of [...textByDigest.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`SHA-256 ${digest}`, 'Used by:');
    for (const use of entry.uses.sort()) {
      lines.push(`- ${use}`);
    }
    lines.push('----- BEGIN VERBATIM CONTENT -----');
    lines.push(entry.content);
    lines.push('----- END VERBATIM CONTENT -----', '');
  }
  return `${lines.join('\n')}\n`;
}

export function findLicenseNoticeErrors(packages, policy) {
  const errors = [];
  const metadataOnly = new Set(policy?.metadataOnlyPackageAllowlist ?? []);
  const packagesById = new Map(packages.map((entry) => [packageIdentity(entry.name, entry.version), entry]));
  for (const [packageId, entry] of packagesById) {
    if (!entry.hasPackageLicenseEvidence && !metadataOnly.has(packageId)) {
      errors.push(
        `${packageId} publishes no package-level license evidence; review it and add the exact version to metadataOnlyPackageAllowlist if the package metadata is sufficient.`,
      );
    }
  }
  for (const packageId of metadataOnly) {
    const entry = packagesById.get(packageId);
    if (!entry) {
      errors.push(`${packageId} is a stale metadataOnlyPackageAllowlist entry.`);
    } else if (entry.hasPackageLicenseEvidence) {
      errors.push(`${packageId} now publishes license or notice text; remove its metadataOnlyPackageAllowlist entry.`);
    }
  }
  return errors;
}

export function findLicensePolicyErrors(packages, policy) {
  const errors = [];
  if (policy?.schemaVersion !== 1) {
    errors.push('scripts/production-license-policy.json must use schemaVersion 1.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(policy?.reviewedAt ?? '')) {
    errors.push('scripts/production-license-policy.json must record its review date as YYYY-MM-DD.');
  }
  const allowed = new Set(policy?.allowedLicenseExpressions ?? []);
  const missingMetadataOverrides = new Map(Object.entries(policy?.missingLicenseMetadataOverrides ?? {}));
  if (allowed.size === 0) {
    errors.push('The production license allowlist must not be empty.');
  }
  if (packages.length === 0) {
    errors.push('The production dependency inventory must not be empty.');
  }

  const packageIds = new Set();
  const packagesById = new Map();
  for (const entry of packages) {
    const packageId = `${entry.name}@${entry.version}`;
    if (typeof entry.name !== 'string' || !entry.name || typeof entry.version !== 'string' || !entry.version) {
      errors.push('Every production dependency must have a name and version.');
      continue;
    }
    if (packageIds.has(packageId)) {
      errors.push(`Production dependency inventory contains duplicate ${packageId}.`);
    }
    packageIds.add(packageId);
    packagesById.set(packageId, entry);
    if (
      entry.packageLicense !== entry.reportedLicense &&
      missingMetadataOverrides.get(packageId) !== entry.reportedLicense
    ) {
      errors.push(
        `${packageId} license grouping ${JSON.stringify(entry.reportedLicense)} does not match package metadata ${JSON.stringify(entry.packageLicense)}.`,
      );
    }
    if (!allowed.has(entry.reportedLicense)) {
      errors.push(`${packageId} declares unreviewed production license ${JSON.stringify(entry.reportedLicense)}.`);
    }
  }
  for (const [packageId, license] of missingMetadataOverrides) {
    const entry = packagesById.get(packageId);
    if (!entry) {
      errors.push(`${packageId} is a stale missingLicenseMetadataOverrides entry.`);
    } else if (entry.packageLicense !== undefined && entry.packageLicense !== null) {
      errors.push(`${packageId} now publishes license metadata; remove its missingLicenseMetadataOverrides entry.`);
    } else if (entry.reportedLicense !== license) {
      errors.push(
        `${packageId} missing-license-metadata override ${JSON.stringify(license)} does not match inventory grouping ${JSON.stringify(entry.reportedLicense)}.`,
      );
    }
  }
  return errors;
}

export function createSpdxDocument(packages, policy, lockfileContent) {
  const normalized = packages.map((entry) => {
    const license = policy.spdxLicenseNormalizations?.[entry.reportedLicense] ?? entry.reportedLicense;
    const identity = `${entry.name}@${entry.version}`;
    return {
      SPDXID: `SPDXRef-Package-${sha256(identity).slice(0, 24)}`,
      name: entry.name,
      versionInfo: entry.version,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: license,
      licenseDeclared: license,
      copyrightText: 'NOASSERTION',
    };
  });
  const inventoryIdentity = JSON.stringify(
    normalized.map(({ name, versionInfo, licenseDeclared }) => [name, versionInfo, licenseDeclared]),
  );
  const namespaceDigest = sha256(`${sha256(lockfileContent)}\n${inventoryIdentity}`);
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: 'ghostbuild-production-dependencies',
    documentNamespace: `https://ghostbuild.dev/.well-known/sbom/production/${namespaceDigest}`,
    creationInfo: {
      // A fixed timestamp keeps lockfile-identical inventories byte-for-byte reproducible.
      created: '1970-01-01T00:00:00Z',
      creators: ['Tool: ghostbuild-production-license-inventory'],
    },
    packages: normalized,
    relationships: normalized.map((entry) => ({
      spdxElementId: 'SPDXRef-DOCUMENT',
      relationshipType: 'DESCRIBES',
      relatedSpdxElement: entry.SPDXID,
    })),
  };
}

export function readProductionLicenseInventory({ spawn = spawnSync } = {}) {
  const result = spawn('pnpm', ['licenses', 'list', '--prod', '--json'], {
    cwd: rootDir,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    throw new Error(`pnpm production license inventory failed${detail ? `: ${detail}` : '.'}`);
  }
  return JSON.parse(result.stdout);
}

export function verifyProductionLicenses() {
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  const report = readProductionLicenseInventory();
  const noticePackages = readNoticePackages(report);
  const packages = noticePackages.map(({ name, version, reportedLicense, packageLicense }) => ({
    name,
    version,
    reportedLicense,
    packageLicense,
  }));
  const lockfileContent = readFileSync(lockfilePath, 'utf8');
  const expectedNoticeArtifact = createThirdPartyLicenseArtifact(noticePackages, policy, lockfileContent);
  const errors = [...findLicensePolicyErrors(packages, policy), ...findLicenseNoticeErrors(noticePackages, policy)];
  if (!existsSync(noticeArtifactPath)) {
    errors.push('public/THIRD_PARTY_LICENSES.txt is missing; run pnpm run licenses:generate.');
  } else if (readFileSync(noticeArtifactPath, 'utf8') !== expectedNoticeArtifact) {
    errors.push('public/THIRD_PARTY_LICENSES.txt is stale; run pnpm run licenses:generate.');
  }
  return {
    errors,
    packages,
    policy,
    lockfileContent,
    expectedNoticeArtifact,
    noticePackageCount: noticePackages.length,
  };
}

function isMainModule() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && !['--spdx', '--write-notices'].includes(args[0]))) {
      throw new Error('Usage: node scripts/verify-production-licenses.mjs [--spdx|--write-notices]');
    }
    const result = verifyProductionLicenses();
    const substantiveErrors = result.errors.filter((error) => !error.startsWith('public/THIRD_PARTY_LICENSES.txt is '));
    if (args[0] === '--write-notices' && substantiveErrors.length === 0) {
      writeFileSync(noticeArtifactPath, result.expectedNoticeArtifact);
      console.log(`Wrote public/THIRD_PARTY_LICENSES.txt for ${result.noticePackageCount} production packages.`);
    } else if (result.errors.length > 0) {
      console.error(result.errors.map((error) => `- ${error}`).join('\n'));
      process.exitCode = 1;
    } else if (args[0] === '--spdx') {
      console.log(JSON.stringify(createSpdxDocument(result.packages, result.policy, result.lockfileContent), null, 2));
    } else {
      console.log(
        `Reviewed production dependency licenses: ${result.packages.length} packages; policy reviewed ${result.policy.reviewedAt}.`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
