import { stripIndents } from '../utils/stripIndent.js';

export function exampleDataInstructions() {
  return stripIndents`
  <example_data_instructions>
    When an app depends on external real-world data that is unavailable during the build, example data may be used to
    make the browser UI previewable. Keep it out of Worker responses, durable storage, and source-of-truth data, and
    clearly label it as non-authoritative example data.

    Do not introduce an external API, database, or secret merely because an app has data. Use local state or the
    Cloudflare storage primitive requested by the user. When a requested external integration needs a credential,
    scaffold the named secret binding and explain how to configure it.
  </example_data_instructions>
`;
}
