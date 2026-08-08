# `@summonghost/title-generation`

Provider-neutral helpers for a two-stage title lifecycle:

1. derive a useful provisional label synchronously from the first prompt;
2. build a small-model prompt and validate its replacement.

```ts
import {
  deriveProvisionalTitle,
  generateTitle,
} from "@summonghost/title-generation";

const provisional = deriveProvisionalTitle(firstPrompt);
const generated = await generateTitle({
  firstPrompt,
  subject: "project",
  execute: (request) =>
    generateText({
      model: configuredSmallModel,
      ...request,
    }),
});
```

The package does not call a model or own credentials, billing, persistence,
background execution, or title provenance. Consumers inject and account for
their own model calls.

Provisional labels remove common request, creation, and retrieval framing, so
short commands such as `get weather` become `weather`. Model requests are
deterministic and share the package's prompt bounds and output validation.
