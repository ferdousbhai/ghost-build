interface Env {
  DB: D1Database;
  APP_STORAGE: R2Bucket;
  AI: Ai;
  CLOUDFLARE_SITE_URL?: string;
  AXIOM_API_TOKEN?: string;
  AXIOM_API_URL?: string;
  AXIOM_DATASET_NAME?: string;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  POSTHOG_KEY?: string;
  POSTHOG_HOST?: string;
  SENTRY_DSN?: string;
  WORKERS_CI_COMMIT_SHA?: string;
  COMMIT_SHA?: string;
  GITHUB_SHA?: string;
}
