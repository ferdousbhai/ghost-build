import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runVerifierIfMain } from './run-verifier.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationNamePattern = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

// D1 records applied migration filenames, so editing an applied file does not
// update production. Every migration must be checksum-tracked, including new
// additive migrations. Post-cutoff migrations also remain subject to rollout
// safety after registration. A destructive contract requires a separate exact-
// digest exception; none are currently approved.
const migrationPolicies = [
  {
    directory: 'migrations',
    legacyCutoff: 19,
    checksums: {
      '0001_cloudflare_data.sql': '6ca7bb824bdbaa46bc4aaa782bb95faabe9cb17f52243911456fdac33f3413ce',
      '0002_better_auth.sql': 'd7f1a7268369f4adf57c578795ae46174e2375f51359692ea42d3d28b72e9104',
      '0003_drop_legacy_sessions.sql': 'd924c56af3aa34333ffd3a9ae0bd5c13fee61fcc640a436cf0bbe41070d150ec',
      '0004_unique_chat_message_state_rank.sql': '5fcb1e2c31dbe60c086f9fbe97a058ed36a8cadcd025c3610572bddd8273128d',
      '0005_unique_active_chat_initial_id.sql': '5b5ce78b3cf7f819785f4f4f796ffc218775300d23f7043e98df89835962ce3c',
      '0006_unique_social_share_chat.sql': 'c096dfc9eed3e1323d455be4ba71a42366cc992cd0653d6ad72566d172ea7a80',
      '0007_feedback.sql': '19bba3c1d0daaab636471601a4ef9c2690dfb4ead75f774639a355e360d35758',
      '0008_cloudflare_user_infrastructure.sql': '309e12d6e6225412391bafb399f601a7f1ec38268e8cc249de2955065756fdc2',
      '0009_cloudflare_connection_generation.sql': '4fd71327d769ff68d4548cb0f32807a82af279ddca22698d44675a35d9a2960c',
      '0010_transcript_reconciliation.sql': '534212fa1e4c27aabff30d52adc5afc491dde37023ddbd460631130e0266db73',
      '0011_cloudflare_auth.sql': '425f407f63282b4cddccea239ca61e16e0138ee2061cb75b9ff2a71a3a3cc274',
      '0012_unique_active_chat_url.sql': '1ab3e4a44e6520c54a74ae501f0933db5ed11910dc4e3a3deff9089f37eecdcd',
      '0013_agent_gc_outbox.sql': '8011edd875ea6fb6465f45de7773ff5f17015095a800af2ad0ed090753f3e3eb',
      '0014_deployment_execution_generation.sql': '659af86e2a456ae0c8e8e74be1057b828812a7b9f14cbd542484a1b801494f9f',
      '0015_deployment_build_artifact_lifecycle.sql':
        '0792706bb2d5614f71723fcf4c26a780304ff1fec04ae09f6caa6b5f76ada0e0',
      '0016_cloudflare_auth_retention.sql': 'cb14b1383e913f614ca7486f5423cfa75ff76bbfcd871724dbfe26d233a855ac',
      '0017_restore_rollout_compatibility.sql': '40774b13b4743d15c1f920c15ef489ce05e1adf864700dd2ea943a41ac632d29',
      '0018_cloudflare_oauth_callback_checkpoint.sql':
        'e56af2fc8eee2940323c4eddedbe908ce50323e0c4332b1e058cf036a7b7f0d5',
      '0019_chat_history_pagination.sql': '1d8ba57a1a9e0b7366c9577c770118f75692de3dcd30c60af1d4364ddc5f7b18',
      '0020_chat_backup_quota.sql': '191e1a61edf93e81ac2eefa7e2194213eb8c1cb16060b0623b1b66c75f29a1ec',
      '0021_deployment_security_inventory.sql': '5e5a4c5e78d03756f2385297f99d705fa1da6ba4377f64b1e0479e219958daed',
      '0022_upload_resource_quotas.sql': '18184f5e2cf43ca247b69922511c2264730488d83f3cebe48e91be526de7c3a8',
      '0023_skill_sync.sql': '17ea5beb522d31c4a0493c6f192e93d80c8d3a72f3d32ec381efae7f2729a17f',
    },
    contractAllowlist: {},
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
