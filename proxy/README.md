# WebContainer Preview Proxy

Ghostbuild starts one local HTTP and HMR WebSocket proxy for each external preview. Giving each preview a distinct
WebContainer origin also gives it distinct browser cookies, which makes multi-user authentication flows testable.

`proxy.cjs` uses `http-proxy` because both normal requests and WebSocket upgrades must reach the same Vite development
server. `build.cjs` bundles that source into `proxy.bundled.cjs`, which the browser writes into the WebContainer and runs
with the source and proxy ports as arguments.

After changing the source, regenerate and verify the committed bundle from the repository root:

```bash
pnpm run build:embedded
pnpm run build:embedded:check
```

The generated CommonJS is base64-wrapped because the WebContainer bootstrap writes it through a single-quoted shell
command. The bundle check prevents source and generated output from drifting.
