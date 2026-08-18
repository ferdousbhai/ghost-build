import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runVerifierIfMain } from './run-verifier.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationNamePattern = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

// Pre-launch schemas begin at one immutable migration. Future changes remain
// additive and checksum-tracked so deployed D1 databases can advance safely.
const migrationPolicies = [
  {
    directory: 'migrations',
    legacyCutoff: 1,
    checksums: {
      '0001_ghostbuild.sql': 'b4ea60ce99e8dafacafc566cdbbf9efdd7668963072b8b5f0860b4cdd8ebdb7a',
      '0002_user_computer_runtimes.sql': 'a9056622b927693b1dbe19669a6442af96388e8ca8b7ca1e55d1e087419ea3ed',
      '0003_launch_controls.sql': 'a9aaab709aabf2db221379e2449c78602aa1d44730f0d9984f185fa2dbad4bd3',
      '0004_remove_legacy_workspace_runtime.sql': 'fd0a0a6a4297ccc046216ff11216bb217afaaeb399548501a2581f7e4450ae5f',
      '0005_runtime_provisioning_leases.sql': '2e485f09167d3a71bf12d20729933be5da35fd25ce91f613a0d6964b2be62c07',
      '0006_remove_launch_controls.sql': '48cb5986ca4291a46609b4714747878adb197dea2024d6c0a8bdd817327bb99f',
      '0007_upstream_monitor_runs.sql': 'f89ee7f275f15543cdf0e96c4bb78acafc8419c0dacb946b96f9d9e53dbe439b',
      '0008_remove_upstream_monitor_runs.sql': '1ca903265be41d756da88c11dcebdec0547309bf4f5fc24c82b2fd9b9f295112',
      '0009_builder_skill_sync.sql': '22d04accde975bceee06ddba21343ff560b31582ab44235017c924daf5a752bf',
      '0010_daily_maintenance_receipts.sql': 'b6b5185e35ed10ce4f29bb0c95b19e65a2b78039c0ae77d42ba5972300244748',
    },
    contractAllowlist: {
      // Explicit pre-launch clean break: the Computer locator replaced this
      // unused table, and keeping it would preserve a false compatibility path.
      '0004_remove_legacy_workspace_runtime.sql': 'fd0a0a6a4297ccc046216ff11216bb217afaaeb399548501a2581f7e4450ae5f',
      // Full launch removes the default-off gate that blocked automatic provisioning.
      '0006_remove_launch_controls.sql': '48cb5986ca4291a46609b4714747878adb197dea2024d6c0a8bdd817327bb99f',
      // Operator receipts moved to the private ghost-build-ops database.
      '0008_remove_upstream_monitor_runs.sql': '1ca903265be41d756da88c11dcebdec0547309bf4f5fc24c82b2fd9b9f295112',
    },
  },
  {
    directory: 'user-workspace-migrations',
    legacyCutoff: 1,
    checksums: {
      '0001_user_workspace.sql': '6647c65caa6992a4f418813a5682b86e1fb65bc91fe62d1af4d81fc7482f2ed5',
      '0002_remove_chat_url_id.sql': '0f09b6846af83b969db428ee1177d5b17fbf0210cc1c53368167d65dfb4004f1',
      '0003_app_resource_gc.sql': 'e5fb53955e71aaf07132dab062b66cac9826755d69a729733d7ceafb11b34f2b',
      '0004_chat_title_sources.sql': '0b0d6c74cc07870155320d75f2be2d10d8aac09090db0fbcefcfd84fe19b1af9',
      '0005_deployment_activity.sql': 'a092ceefd76d8e0af1afd73e2d11e03ddcae1e9694fc5673a55f985d65854cbd',
      '0006_runtime_controls.sql': '952b8c35936e312b128eda8aaaf45453a312aef4333f9812a293ef4cc79294e6',
    },
    contractAllowlist: {
      // Chat identity has one immutable key; remove the unused alternate URL column and index.
      '0002_remove_chat_url_id.sql': '0f09b6846af83b969db428ee1177d5b17fbf0210cc1c53368167d65dfb4004f1',
    },
  },
  {
    directory: 'template/migrations',
    legacyCutoff: 1,
    checksums: {
      '0001_app_data.sql': '114d3df6142196cb43a95e5896e1b9a8e8753514becf3400884b27acb5793d65',
    },
    contractAllowlist: {},
  },
  {
    directory: 'template/agent-security-migrations',
    legacyCutoff: 1,
    checksums: {
      '0001_agent_security.sql': 'cc62c34bcfb5e176155e371a099d000679ae69877facf252fe3d3c7e1190fbeb',
    },
    contractAllowlist: {},
  },
];

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function stripSqlCommentsAndLiterals(sql) {
  let output = '';
  let state = 'normal';

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];

    if (state === 'line-comment') {
      if (character === '\n') {
        state = 'normal';
        output += '\n';
      } else {
        output += ' ';
      }
      continue;
    }
    if (state === 'block-comment') {
      if (character === '*' && next === '/') {
        output += '  ';
        index += 1;
        state = 'normal';
      } else {
        output += character === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (state !== 'normal') {
      const terminator =
        state === 'single-quote' ? "'" : state === 'double-quote' ? '"' : state === 'backtick' ? '`' : ']';
      if (character === terminator) {
        if (state !== 'bracket' && next === terminator) {
          output += '  ';
          index += 1;
        } else {
          output += ' ';
          state = 'normal';
        }
      } else {
        output += character === '\n' ? '\n' : ' ';
      }
      continue;
    }

    if (character === '-' && next === '-') {
      output += '  ';
      index += 1;
      state = 'line-comment';
    } else if (character === '/' && next === '*') {
      output += '  ';
      index += 1;
      state = 'block-comment';
    } else if (character === "'") {
      output += ' ';
      state = 'single-quote';
    } else if (character === '"') {
      output += ' ';
      state = 'double-quote';
    } else if (character === '`') {
      output += ' ';
      state = 'backtick';
    } else if (character === '[') {
      output += ' ';
      state = 'bracket';
    } else {
      output += character;
    }
  }

  return output;
}

function topLevelTokens(statement) {
  const tokens = [];
  let depth = 0;
  for (const match of statement.matchAll(/[A-Za-z_]+|[()]/g)) {
    const value = match[0].toUpperCase();
    if (value === '(') {
      depth += 1;
    } else if (value === ')') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0) {
      tokens.push(value);
    }
  }
  return tokens;
}

function hasUnboundedMutation(statement, mutation) {
  const tokens = topLevelTokens(statement);
  const mutationIndex = tokens.indexOf(mutation);
  return mutationIndex !== -1 && !tokens.slice(mutationIndex + 1).includes('WHERE');
}

export function findUnsafeD1MigrationOperations(sql) {
  const sanitized = stripSqlCommentsAndLiterals(sql);
  const operations = new Set();

  if (/\bDROP\s+(?:TABLE|INDEX|VIEW|TRIGGER)\b/i.test(sanitized)) {
    operations.add('DROP removes schema in place');
  }
  if (/\bALTER\s+TABLE\b[^;]*\bRENAME\s+(?:TO|COLUMN)\b/i.test(sanitized)) {
    operations.add('ALTER TABLE RENAME rewrites schema in place');
  }
  if (/\bALTER\s+TABLE\b[^;]*\bDROP\s+(?:COLUMN|CONSTRAINT)\b/i.test(sanitized)) {
    operations.add('ALTER TABLE DROP removes schema in place');
  }
  if (/\b(?:INSERT\s+OR\s+REPLACE|REPLACE)\s+INTO\b/i.test(sanitized)) {
    operations.add('REPLACE can delete conflicting rows');
  }
  if (/\bPRAGMA\s+(?:main\.)?writable_schema\b/i.test(sanitized)) {
    operations.add('PRAGMA writable_schema bypasses schema safety');
  }
  if (/\bPRAGMA\s+(?:main\.)?foreign_keys\s*=\s*(?:OFF|0)\b/i.test(sanitized)) {
    operations.add('PRAGMA foreign_keys = OFF bypasses referential integrity');
  }

  for (const statement of sanitized.split(';')) {
    if (hasUnboundedMutation(statement, 'UPDATE')) {
      operations.add('UPDATE without a top-level WHERE rewrites every row');
    }
    if (hasUnboundedMutation(statement, 'DELETE')) {
      operations.add('DELETE without a top-level WHERE removes every row');
    }
  }

  return [...operations];
}

export function findD1MigrationSafetyErrors(migrations, options) {
  const { directory, checksums, legacyCutoff, contractAllowlist = {} } = options;
  const errors = [];
  const byName = new Map(migrations.map((migration) => [migration.name, migration.content]));

  for (const [name, expectedDigest] of Object.entries(checksums)) {
    const content = byName.get(name);
    if (content === undefined) {
      errors.push(`${directory}/${name} is checksum-tracked D1 migration history and must not be removed.`);
    } else if (sha256(content) !== expectedDigest) {
      errors.push(
        `${directory}/${name} is checksum-tracked D1 migration history and must remain immutable; add a new additive migration instead.`,
      );
    }
  }

  const futureMigrations = [];
  for (const migration of migrations) {
    const match = migrationNamePattern.exec(migration.name);
    if (!match) {
      errors.push(`${directory}/${migration.name} must use the NNNN_lowercase_name.sql migration format.`);
      continue;
    }
    const version = Number.parseInt(match[1], 10);
    if (!Object.hasOwn(checksums, migration.name)) {
      errors.push(`${directory}/${migration.name} must have an exact SHA-256 checksum entry before it can ship.`);
    }
    if (version <= legacyCutoff && !Object.hasOwn(checksums, migration.name)) {
      errors.push(
        `${directory}/${migration.name} cannot be inserted into legacy migration history at or before ${String(legacyCutoff).padStart(4, '0')}.`,
      );
    }
    if (version > legacyCutoff) {
      futureMigrations.push({ ...migration, version, digest: sha256(migration.content) });
    }
  }

  futureMigrations.sort((left, right) => left.version - right.version || left.name.localeCompare(right.name));
  let expectedVersion = legacyCutoff + 1;
  for (const migration of futureMigrations) {
    if (migration.version !== expectedVersion) {
      errors.push(
        `${directory}/${migration.name} must be migration ${String(expectedVersion).padStart(4, '0')} so D1 history stays contiguous.`,
      );
      expectedVersion = migration.version;
    }
    expectedVersion += 1;
    const unsafeOperations = findUnsafeD1MigrationOperations(migration.content);
    const approvedContractDigest = contractAllowlist[migration.name];
    if (approvedContractDigest !== undefined && approvedContractDigest !== migration.digest) {
      errors.push(`${directory}/${migration.name} contract allowlist digest does not match the migration content.`);
    }
    if (approvedContractDigest !== migration.digest) {
      for (const operation of unsafeOperations) {
        errors.push(
          `${directory}/${migration.name} is not expand/contract safe: ${operation}; stage the additive replacement before a separately reviewed exact-digest contract exception.`,
        );
      }
    } else if (unsafeOperations.length === 0) {
      errors.push(`${directory}/${migration.name} has an unnecessary contract allowlist entry; remove the exception.`);
    }
  }

  for (const name of Object.keys(contractAllowlist)) {
    if (!Object.hasOwn(checksums, name)) {
      errors.push(`${directory}/${name} contract allowlist entry must reference a checksum-tracked migration.`);
    }
    if (!byName.has(name)) {
      errors.push(`${directory}/${name} contract allowlist entry must reference an existing migration.`);
    }
    const version = Number.parseInt(migrationNamePattern.exec(name)?.[1] ?? '0', 10);
    if (version <= legacyCutoff) {
      errors.push(`${directory}/${name} contract allowlist entry is unnecessary for legacy migration history.`);
    }
  }

  return errors;
}

function readMigrations(repositoryRoot, directory) {
  const path = resolve(repositoryRoot, directory);
  return readdirSync(path)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => ({ name, content: readFileSync(resolve(path, name), 'utf8') }));
}

export function verifyD1MigrationSafety(repositoryRoot = rootDir) {
  return migrationPolicies.flatMap(({ directory, checksums, legacyCutoff, contractAllowlist }) =>
    findD1MigrationSafetyErrors(readMigrations(repositoryRoot, directory), {
      directory,
      checksums,
      legacyCutoff,
      contractAllowlist,
    }),
  );
}

runVerifierIfMain(import.meta.url, verifyD1MigrationSafety);
