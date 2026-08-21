import { PREVIEW_SNAPSHOT_ROOT } from './preview-lifecycle';

/**
 * Which guarantee a preview carries.
 *
 * `production` is checkpoint-bound. It is built from one exact content revision and that
 * revision is asserted before the build, after the build, and again before publication, so
 * the reviewed bytes are the bytes deployment would publish.
 *
 * `dev` is a Vite dev server that tracks live workspace state. It is deliberately bound to no
 * revision at all: the project changes underneath it and that is the point. A dev preview is
 * therefore never evidence that a revision builds, never a validation receipt, and must never
 * satisfy a deployment precondition.
 */
export type PreviewMode = 'production' | 'dev';

export function requirePreviewMode(value: unknown): PreviewMode {
  if (value === undefined || value === 'production') {
    return 'production';
  }
  if (value === 'dev') {
    return 'dev';
  }
  throw new SyntaxError('Invalid preview mode.');
}

/**
 * Reading a preview row back from durable storage. A workspace provisioned before dev previews
 * existed has no stored mode, and every preview it recorded was checkpoint-bound.
 */
export function storedPreviewMode(value: unknown): PreviewMode {
  return value === 'dev' ? 'dev' : 'production';
}

/**
 * Where the dev server runs.
 *
 * Not `/home/project`, even though that is where the live project is. `/home` is Cloudflare
 * Computer's projection of the durable VFS, and everything written under it is reconciled back
 * into the Durable Object's SQLite. A dev server needs an installed dependency tree and a
 * `.wrangler` local-state directory next to the sources; putting either under `/home` would copy
 * hundreds of megabytes of `node_modules` into durable storage and churn it on every pull. So the
 * dev server runs from a container-local root, exactly like the production preview, and the
 * durable project is projected into it change by change.
 */
export function devPreviewRoot(previewId: string): string {
  return `${PREVIEW_SNAPSHOT_ROOT}/dev-${previewId}`;
}

/**
 * `--mode ghostbuild-isolated-preview` is what selects `wrangler.preview.jsonc` in the generated
 * project's Vite config. Without it the Cloudflare plugin loads the production `wrangler.jsonc`
 * and tries to bind the real, possibly not-yet-provisioned D1/R2/KV resources — the same reason
 * the production preview build passes that mode. The template's own `dev` script does not, so it
 * is intentionally not reused here.
 */
export function devPreviewServerCommand(port: number): string {
  return `pnpm exec vite dev --mode ghostbuild-isolated-preview --host 0.0.0.0 --port ${port} --strictPort`;
}

/**
 * Map a durable project path onto its projection inside the dev root.
 *
 * The caller has already validated the path against the project root, but this writes into a
 * container filesystem outside the VFS sandbox, so the containment check is repeated here rather
 * than trusted from a layer above.
 */
export function devPreviewProjectedPath(args: { devRoot: string; projectRoot: string; path: string }): string {
  const suffix = args.path.slice(args.projectRoot.length);
  if (
    !args.path.startsWith(`${args.projectRoot}/`) ||
    !suffix.startsWith('/') ||
    suffix.split('/').includes('..') ||
    suffix.includes('\0')
  ) {
    throw new Error(`Dev preview projection path is outside the project root: ${args.path}`);
  }
  return `${args.devRoot.replace(/\/+$/, '')}${suffix}`;
}

export function containerParentDirectory(path: string): string {
  const separator = path.lastIndexOf('/');
  return separator <= 0 ? '/' : path.slice(0, separator);
}

/** Deletions have to reach the dev root too, or Vite keeps serving a module the project removed. */
export function devPreviewRemoveCommand(args: { paths: readonly string[]; quote: (value: string) => string }): string {
  return ['set -eu', ...args.paths.map((path) => `rm -rf -- ${args.quote(path)}`)].join('\n');
}
