import { env } from 'cloudflare:workers'

type ModelEnv = Cloudflare.Env & {
  OPENAI_API_KEY?: string
}

export function readServerOpenAiApiKey() {
  return (env as ModelEnv).OPENAI_API_KEY ?? process.env.OPENAI_API_KEY
}
