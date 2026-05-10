# Ghost Coder

Ghost Coder is an open-source coding agent for non-technical users who want to turn an app idea into a deployed Cloudflare Worker.

## Business Logic

- Users sign in with Google.
- Users bring their own OpenAI API key; it stays in their browser.
- The Ghost uses GPT-5.5 with low reasoning for planning and coding work.
- The Ghost has Cloudflare Skills and the Cloudflare API MCP server available by default.
- The app avoids product-specific MCP servers; Cloudflare platform actions route through the Cloudflare API MCP server.
- Generated apps deploy to Cloudflare Workers.
- Paid infrastructure is handled through Cloudflare/Stripe agent flows, including account setup, domains, and Cloudflare usage.
- Ghost Coder never stores raw payment card data.
- Paid or destructive Cloudflare actions should require clear user confirmation.

The core product flow is prompt -> plan -> agent actions -> preview -> deploy.
