#!/usr/bin/env bash
# Deploy, with the commit baked into the image.
#
#   npm run deploy                 refuses anything that would make the marker lie
#   npm run deploy -- --allow-dirty  stamps <sha>-dirty instead, and says so
#
# This exists because `flyctl deploy` on its own produces an image nothing can
# tie to a commit: no label, no version endpoint, nothing in a header. The build
# argument below is what /health, /status and the image label report back, so
# this script is the deploy command and a bare `flyctl deploy` is not.
#
# Everything it refuses, it refuses because the alternative is a marker that is
# confidently wrong, which is worse than no marker at all.
set -euo pipefail
cd "$(dirname "$0")/.."

ALLOW_DIRTY=0
ARGS=()
for a in "$@"; do
  if [ "$a" = "--allow-dirty" ]; then ALLOW_DIRTY=1; else ARGS+=("$a"); fi
done

command -v flyctl >/dev/null 2>&1 || { echo "flyctl is not on PATH." >&2; exit 127; }

# HEAD, not GITHUB_SHA, whenever this is a git work tree.
#
# The dirtiness check below can only compare against the local HEAD, so taking
# the SHA from anywhere else would stamp one commit while having verified a
# different one. GITHUB_SHA is the fallback for a context with no git at all,
# and it is shape-checked because a marker is only worth having if it is a SHA.
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  SHORT="$(git rev-parse --short HEAD)"   # git picks the abbreviation length
  IN_GIT=1
else
  SHORT="$(printf '%s' "${GITHUB_SHA:-}" | tr '[:upper:]' '[:lower:]' | cut -c1-12)"
  IN_GIT=0
  case "$SHORT" in
    *[!0-9a-f]* | "") echo "Not a git work tree and GITHUB_SHA is not a hex SHA." >&2; exit 1 ;;
  esac
fi

if [ "$IN_GIT" -eq 1 ]; then
  # No --untracked-files=no here, and that is the whole point of this check.
  #
  # The Dockerfile copies the build context with `COPY . .`, and .dockerignore
  # excludes node_modules, dist, env files and logs but nothing under src. So an
  # untracked source file IS in the image while being invisible to a tracked-only
  # status, and the marker would name a commit that does not contain the code
  # that is running. On 2026-09-07 a deploy from a shared checkout shipped
  # another session's uncommitted work by exactly this route.
  DIRTY="$(git status --porcelain)"
  if [ -n "$DIRTY" ]; then
    if [ "$ALLOW_DIRTY" -eq 0 ]; then
      echo "Refusing to deploy: the working tree is not clean, so the marker ${SHORT}" >&2
      echo "would name a commit that does not contain what this image would run." >&2
      echo "$DIRTY" >&2
      echo "Commit, stash, or pass --allow-dirty to stamp ${SHORT}-dirty instead." >&2
      exit 1
    fi
    # Deploying anyway is allowed; pretending it was a clean build is not.
    SHORT="${SHORT}-dirty"
    echo "WARNING: deploying a dirty tree. Stamping ${SHORT}." >&2
  fi

  # A marker nobody can look up is only half a marker: /status tells the reader
  # this commit can be checked against the repository. Not fatal, because
  # deploying before pushing is a legitimate emergency.
  if ! git branch -r --contains HEAD 2>/dev/null | grep -q .; then
    echo "WARNING: HEAD is not on any remote branch yet, so ${SHORT} cannot be looked up." >&2
  fi
fi

echo "Deploying ${SHORT}"
exec flyctl deploy --build-arg "GIT_SHA=${SHORT}" ${ARGS+"${ARGS[@]}"}
