import { env } from "cloudflare:workers";

export type AppBindings = Pick<Env, "DB" | "APP_STORAGE">;

/**
 * Exposes only application data bindings to generated routes. Inference and
 * agent bindings remain confined to the reviewed server boundary.
 */
export function getAppBindings(): AppBindings {
  return {
    DB: env.DB,
    APP_STORAGE: env.APP_STORAGE,
  };
}
