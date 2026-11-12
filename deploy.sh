#!/usr/bin/env bash
# Runs on the server after GitHub Actions has moved the app folder to the new commit.
#   bash deploy.sh <previous-commit>
# Refuses a broken commit: it rolls the folder back to <previous-commit> and exits 1,
# so the live site keeps running the last good version.
set -uo pipefail
cd "$(dirname "$0")"
OLD="${1:-}"
APP_ROOT="sukuma-sauti"
source "$HOME/nodevenv/$APP_ROOT/24/bin/activate"

rollback() {
  echo "DEPLOY REFUSED: $1"
  if [ -n "$OLD" ]; then git reset --hard "$OLD" >/dev/null && echo "Rolled back to $OLD"; fi
  exit 1
}

# 1. Nothing half-merged, nothing that cannot even load.
if git grep -nE '^(<<<<<<<|>>>>>>>)( |$)' -- . >/dev/null; then rollback "merge-conflict markers in the code"; fi
for f in app.js server.js public/app.js scripts/*.js; do
  node --check "$f" || rollback "syntax error in $f"
done
for f in package.json prompts.json; do
  node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" || rollback "invalid JSON in $f"
done
node -e "const p=require('./prompts.json'); if(!Array.isArray(p)||!p.length||new Set(p.map(x=>x.id)).size!==p.length) process.exit(1)" \
  || rollback "prompts.json must be a non-empty list with unique ids"

# 2. Install packages only when the package files changed.
if [ -z "$OLD" ] || ! git diff --quiet "$OLD" HEAD -- package.json package-lock.json; then
  echo "Package files changed: installing"
  cloudlinux-selector install-modules --json --interpreter nodejs --app-root "$APP_ROOT" || rollback "package install failed"
fi

# 3. Restart the app so it loads the new code.
cloudlinux-selector restart --json --interpreter nodejs --app-root "$APP_ROOT" || rollback "restart failed"
echo "Deployed $(git rev-parse --short HEAD)"
