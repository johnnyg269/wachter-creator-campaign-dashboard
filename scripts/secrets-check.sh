#!/usr/bin/env bash
# Scans git-TRACKED files for real-looking secret values (placeholders and
# test fixtures are allowlisted). Run: npm run secrets:check
# Rule of thumb: use environment variables; never commit secrets.
set -euo pipefail
cd "$(dirname "$0")/.."

PATTERNS=(
  'apify_api_[A-Za-z0-9]{20,}'                       # Apify tokens
  'sbp_[a-f0-9]{30,}'                                # Supabase access tokens
  'postgres(ql)?://[^<"'"'"' ]+:[^<"'"'"' ]{8,}@'    # real connection strings (placeholders use <PASSWORD> / short u:p)
  'eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{30,}'        # JWTs (Supabase anon/service keys)
  'vercel_[A-Za-z0-9]{20,}'                          # Vercel tokens
  'ADMIN_PASSWORD=[^<\s][^\s]{3,}'                   # inline admin password values
  'CRON_SECRET=[a-f0-9]{16,}'                        # inline cron secret values
  'CRONJOB_ORG_API_KEY=[A-Za-z0-9+/]{20,}={0,2}'     # inline cron-job.org API key values
  'AIza[0-9A-Za-z_-]{35}'                            # Google / YouTube Data API keys
)

FAIL=0
for p in "${PATTERNS[@]}"; do
  if git grep -nIE "$p" -- . ':(exclude)scripts/secrets-check.sh' 2>/dev/null; then
    echo "✗ potential secret matches pattern: $p"
    FAIL=1
  fi
done

if [ "$FAIL" -eq 1 ]; then
  echo ""
  echo "Secret-like values found in tracked files. Move them to environment"
  echo "variables (.env.local locally, Vercel env vars in production)."
  exit 1
fi
echo "✓ no secret values in tracked files"
