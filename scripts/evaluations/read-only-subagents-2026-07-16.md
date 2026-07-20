# Read-only sub-agent evaluation — 2026-07-16

Model: `@cf/zai-org/glm-5.2`

The evaluation compared a single parent call with an explorer- or verifier-assisted parent call on four fixed,
synthetic repository-analysis cases. Both variants received the same bounded workspace facts. Success required the
essential expected facts; spelling and optional path repetition did not affect the score.

| Variant  | Success | Total latency | Input tokens | Output tokens | Estimated cost |
| -------- | ------- | ------------- | ------------ | ------------- | -------------- |
| Baseline | 4 / 4   | 26,344 ms     | 454          | 1,697         | $0.0081024     |
| Assisted | 4 / 4   | 54,070 ms     | 2,150        | 3,099         | $0.0166464     |

The assisted path produced no success improvement while taking 2.05× as long and costing 2.05× as much. It sometimes
made an already-correct answer more explicit, but that did not change task success. A preliminary 400-token run also
showed that the model can consume the entire limit in reasoning and return no answer, so the harness and runtime use a
1,000-token child cap.

Conclusion: neither role is justified for production. Ghostbuild therefore carries no dormant facet-agent runtime or
child inference path. A larger end-to-end build benchmark must demonstrate a material success gain before delegation is
implemented.

The reproducible harness is `read-only-subagents.worker.ts`; run cases `0` through `3` as documented in
`DEVELOPMENT.md`.
