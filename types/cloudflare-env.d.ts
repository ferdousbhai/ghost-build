interface Env {
  DB: D1Database;
  APP_STORAGE: R2Bucket;
  CLIENT_TELEMETRY_RATE_LIMITER: RateLimit;
  CLOUDFLARE_OAUTH_START_RATE_LIMITER: RateLimit;
  CHAT_BACKUP_RATE_LIMITER: RateLimit;
  CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: string;
  CLOUDFLARE_OAUTH_CLIENT_ID?: string;
  CLOUDFLARE_OAUTH_CLIENT_SECRET: string;
  CLOUDFLARE_OAUTH_SCOPES: 'openid profile email account-settings.read workers-scripts.write d1.write workers-r2.write ai.read';
  DEPLOYMENT_PROXY_JWT_SECRET: string;
  WORKERS_CI_COMMIT_SHA?: string;
  COMMIT_SHA?: string;
  GITHUB_SHA?: string;
}
