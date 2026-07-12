interface Env {
  DB: D1Database;
  APP_STORAGE: R2Bucket;
  AI: Ai;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  WORKERS_CI_COMMIT_SHA?: string;
  COMMIT_SHA?: string;
  GITHUB_SHA?: string;
}
