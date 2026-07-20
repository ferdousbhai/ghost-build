# Workers AI prompt-cache evaluation — 2026-07-16

Model: `@cf/zai-org/glm-5.2`

Cloudflare documents automatic prefix caching for supported Workers AI models and recommends `x-session-affinity` to
route a session back to the model replica holding its prefix tensors. GLM-5.2 publishes a discounted cached-input price.
Ghostbuild therefore tested an opaque stable affinity with a large static system prefix and a changed final user suffix.

| Cacheable prefix | Cold control | Warm affinity | Latency reduction | Reported cached tokens | Cost reduction |
| ---------------- | ------------ | ------------- | ----------------- | ---------------------- | -------------- |
| ~7,370 tokens    | 7,899 ms     | 652 ms        | 91.75%            | 0                      | 0.32%          |
| ~18,748 tokens   | 9,288 ms     | 4,992 ms      | 46.25%            | 0                      | 0.13%          |

Both warm requests returned the new suffix-specific answer, so reusing the prefix did not freeze dynamic instructions.
Session affinity produced a material latency improvement in both runs, but the binding reported zero cached tokens.
Ghostbuild consequently records these live samples as cache misses and claims no cached-token cost saving. Production
telemetry will distinguish a verified hit only when Workers AI reports a positive cached-token count; absent metadata is
reported as unavailable.

The production change sends only an opaque SHA-256 transcript-generation affinity. Stable system instructions remain at
the front of the prompt, while project/workspace data remains in the latest user message. Model-visible input changes
invalidate the exact prefix naturally; a salted telemetry fingerprint changes with the model, prompt, tool schema,
active tools, or project instructions without logging their contents. AI Gateway response caching is intentionally not
used because changing agent turns are not identical-response workloads.

Reproduce the benchmark with `prompt-cache.worker.ts` and `prompt-cache.wrangler.jsonc` as documented in
`DEVELOPMENT.md`.

References:

- <https://developers.cloudflare.com/workers-ai/features/prompt-caching/>
- <https://developers.cloudflare.com/workers-ai/models/glm-5.2/>
