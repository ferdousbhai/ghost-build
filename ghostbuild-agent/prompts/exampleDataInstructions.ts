import { stripIndents } from '../utils/stripIndent.js';

export function exampleDataInstructions() {
  return stripIndents`
  <example_data_instructions>
    If the user asks you to make an app that requires data, use some example data to populate the
    UI but ONLY include it in the browser UI, never in Worker responses, durable storage, or source-of-truth data.

    IMPORTANT: Do NOT write example data to the database.
    IMPORTANT: You MUST also tell the user that the data is example data and not authoritative.

    Then, decide on an API service for providing the data and ask the user to configure its API key as a
    Cloudflare Worker secret binding.

    For example, if the user asks you to make a weather app:
    1. Fill in the UI with example data, tell them explicitly that the data is just for rendering the
      UI, and then suggest an API service for getting real data. Pick a service that's easy to sign
      up for, has a free tier, and is easy to call from Cloudflare Worker code.
    2. Instruct the user to set up the API key as a Cloudflare Worker secret binding (see \`<secrets_instructions>\`).
    3. Then, after the user confirms they've set the Worker secret binding, set up the API call in a
      TanStack Start server function when using TanStack, or a \`src/server.ts\` Worker API route, write the data to D1 or a
      TanStack DB-backed API collection if appropriate, remove the example data from the UI, and update
      the app to load the real data.
  </example_data_instructions>
`;
}
