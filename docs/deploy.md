# Deployment workflow

## Primary: GitHub → Vercel auto-deploy

Pushing to the **`main`** branch of
`github.com/johnnyg269/wachter-creator-campaign-dashboard` triggers an
automatic production deployment of the Vercel project
**`wachter-creator-campaign-dashboard`** (owner `johng26 / johng26s-projects`).

Check deployment status at: Vercel dashboard → the project → **Deployments**
tab (each shows the source commit SHA and build logs).

> **One-time connection requirement.** Auto-deploy only fires when the Vercel
> project's **Git** connection is attached. If pushes stop deploying, the
> Vercel↔GitHub OAuth connection has likely expired (symptom: `vercel git
> connect` and the link API both return *"you need to install the GitHub
> integration first"* even though the GitHub App is installed). Fix it in the
> dashboard: **Project → Settings → Git → Connect Git Repository**, re-authorize
> GitHub if prompted, pick `johnnyg269/wachter-creator-campaign-dashboard`,
> production branch `main`. CLI/API cannot refresh that OAuth token.

## Backup: Vercel CLI

The CLI path always works and stays as the fallback:

```
npx vercel@latest deploy --prod --yes
```

(Run from the repo root; the project is linked via `.vercel/project.json`.)

## Notes

- **Never** print, commit, or expose env var values. Production env vars live in
  Vercel (Project → Settings → Environment Variables); do not overwrite them.
- `.env*` files are gitignored and must stay out of commits.
- **cron-job.org** is an external scheduler that calls `/api/cron/refresh` on a
  schedule; it is independent of how the app is deployed and is unaffected by
  the GitHub/Vercel connection.

<!-- auto-deploy connected 2026-06-13 -->
