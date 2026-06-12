# Security & Token Rotation

Credentials for this project live in **environment variables only** —
`.env.local` locally (gitignored), Vercel env vars in production, GitHub
Actions secrets for the scheduled refresh. Never commit secrets; run
`npm run secrets:check` to scan tracked files.

## What needs rotation (and what already happened)

| Credential | Status | Why |
|---|---|---|
| `APIFY_TOKEN` | **Rotate when convenient** | pasted into a chat during setup |
| Supabase personal access token (`sbp_…`) | **Rotate when convenient** | pasted into a chat during setup |
| Supabase **database password** | ✅ already rotated (2026-06-11) | reset via the Management API during deployment; old value invalid |
| `CRON_SECRET` | no exposure | generated locally, never shared |
| `CRONJOB_ORG_API_KEY` (cron-job.org account API key) | **Rotate when convenient** | pasted into a chat during scheduler setup; lives in `.env.local` + Vercel env (sensitive). Rotate at console.cron-job.org → Settings → API |
| `ADMIN_PASSWORD` | no exposure | generated locally, shown once in a private session |

## Rotating the Apify token

1. [console.apify.com](https://console.apify.com) → **Settings → API & Integrations**
   → create a new token, then delete the old one.
2. Update the value in:
   - **Vercel**: Project → Settings → Environment Variables → `APIFY_TOKEN`
     (Production + Development), then **redeploy** (env vars apply at deploy).
   - **Local**: `.env.local` → `APIFY_TOKEN=`
3. Verify (see below).

## Rotating the Supabase personal access token

This token (`sbp_…`) is your *account* Management API token — the app itself
never uses it, so rotating it cannot break production.

1. [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens)
   → revoke the exposed token → generate a new one if you still need one.
2. Nothing to update in the app or Vercel.

## Rotating the Supabase database password (only if needed again)

1. Supabase → Project Settings → Database → **Reset database password**
   (or via the Management API).
2. Rebuild `DATABASE_URL` with the new password — pooled form:
   `postgresql://postgres.<ref>:<password>@aws-1-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1`
3. Update `DATABASE_URL` in Vercel (Production + Development) and redeploy.

## Verifying after any rotation

```bash
npm run secrets:check                       # nothing leaked into the repo
```

Then in production:
1. Open `/admin` → **Production readiness** — Apify token row must read
   "connected", database row "Supabase/Postgres connected".
2. Trigger a refresh (admin **Refresh now**, or the cron endpoint with the
   Bearer secret) and confirm it completes with status `success` in
   **Refresh logs**.
3. Dashboard KPIs update and the confidence badge stays green.
