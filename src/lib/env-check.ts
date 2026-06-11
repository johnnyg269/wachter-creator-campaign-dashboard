// Production environment validation — booleans and human-readable warnings
// only, never the secret values themselves. Powers the /admin readiness card
// and the env-validation tests.

import { getAdminPassword, getApifyToken, getCronSecret, getActorIdFromEnv } from "./config";
import { PLATFORMS } from "./types";

export interface EnvCheckResult {
  ok: boolean;
  /** Hard problems that make a production deployment unsafe/broken. */
  errors: string[];
  /** Soft problems that degrade the deployment but don't break it. */
  warnings: string[];
}

export function checkProductionEnv(env: NodeJS.ProcessEnv = process.env): EnvCheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!env.DATABASE_URL?.trim()) {
    warnings.push(
      "DATABASE_URL is not set — storage will be ephemeral (/tmp). Connect Supabase Postgres before sharing broadly.",
    );
  } else if (!/^postgres(ql)?:\/\//.test(env.DATABASE_URL.trim())) {
    errors.push("DATABASE_URL does not look like a Postgres connection string.");
  }

  if (!getApifyToken()) {
    warnings.push("APIFY_TOKEN is not set — TikTok/Instagram/Facebook (and YouTube fallback) sources stay disconnected.");
  }

  const missingActors = PLATFORMS.filter((p) => !getActorIdFromEnv(p));
  if (missingActors.length > 0) {
    warnings.push(
      `Actor IDs missing for: ${missingActors.join(", ")} (runtime config in the database also works, but env vars survive a fresh database).`,
    );
  }

  if (!getCronSecret()) {
    errors.push("CRON_SECRET is not set — the scheduled refresh endpoint refuses all requests without it.");
  }

  if (!getAdminPassword()) {
    errors.push("ADMIN_PASSWORD is not set — /admin would be open to anyone with the URL.");
  }

  return { ok: errors.length === 0, errors, warnings };
}
