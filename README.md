# Ghostbuild

Ghostbuild is an AI builder for applications on the Cloudflare developer platform. It runs in the browser, generates
Cloudflare-native projects, and deploys them to the user's own Cloudflare account.

Try it at [ghostbuild.dev](https://ghostbuild.dev).

## Requirements

- Node.js 26 or newer
- pnpm 11.14.0, as pinned by `packageManager`
- A Cloudflare account for production deployment

## Setup

```bash
nvm use
corepack enable
pnpm install --frozen-lockfile
pnpm run validate
```

Production provisioning and deployment are documented in [DEVELOPMENT.md](DEVELOPMENT.md).

## Commands

| Command                     | Purpose                                    |
| --------------------------- | ------------------------------------------ |
| `pnpm run validate`         | Run the complete repository validation     |
| `pnpm run build`            | Build the root Worker application          |
| `pnpm run rebuild-template` | Rebuild the generated-application snapshot |
| `pnpm run deploy`           | Validate, provision, migrate, and deploy   |

## Repository Map

- `app/server.ts` is the root Cloudflare Worker entrypoint.
- `app/agents/` and `app/lib/.server/` own the durable agent runtime and model orchestration.
- `app/components/` and `app/routes/` contain the product interface.
- `app/lib/cloudflare/` contains persistence and data-operation boundaries.
- `ghostbuild-agent/` contains shared prompts, protocols, parsing, and tool definitions.
- `template/` is the independent source project copied into generated applications.
- `migrations/` contains the root D1 schema history.

See [AGENTS.md](AGENTS.md) for a source index and [DEVELOPMENT.md](DEVELOPMENT.md) for contributor workflows.

## Contributing and Security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Report suspected vulnerabilities privately as
described in [SECURITY.md](SECURITY.md).

Ghostbuild began as a substantially modified derivative of
[Chef](https://github.com/get-convex/chef), which itself was based on
[bolt.diy](https://github.com/stackblitz-labs/bolt.diy). Ghostbuild is licensed under the
[Apache License 2.0](LICENSE); retained third-party notices are in [NOTICE](NOTICE) and
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
