# Preview Frame Helper

`worker.mts` handles the correlated `postMessage` requests Ghostbuild uses to ping a generated-app preview and capture a
screenshot. It accepts messages only from the frame's parent and replies to the exact requesting origin.

`build.cjs` bundles the helper into `worker.bundled.mjs`. The root Worker serves that committed artifact from
`https://ghostbuild.dev/scripts/worker.bundled.mjs` with public CORS headers because WebContainer preview origins are
ephemeral and credentialless.

After changing the source, regenerate and verify the committed bundle from the repository root:

```bash
pnpm run build:embedded
pnpm run build:embedded:check
```

Testing an updated helper against a WebContainer from local development requires an HTTPS URL that the preview can
reach; WebContainer frames cannot import it from the host's `localhost` directly.
