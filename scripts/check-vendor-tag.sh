#!/usr/bin/env bash
set -euo pipefail

# Do not use .gitmodules: this check must always consult the official upstream.
upstream=https://github.com/can1357/oh-my-pi.git
entry=$(git ls-tree HEAD -- vendor/oh-my-pi)
if [[ ! $entry =~ ^160000\ commit\ ([0-9a-f]{40})$'\t'vendor/oh-my-pi$ ]]; then
  echo 'vendor/oh-my-pi is missing or is not a gitlink' >&2
  exit 1
fi
commit=${BASH_REMATCH[1]}

# Annotated tag refs name tag objects; only their peeled targets are candidates.
refs=$(git ls-remote --tags "$upstream") || {
  echo 'Could not read upstream tags' >&2
  exit 1
}
tag=$(awk -v commit="$commit" '
  { if ($2 ~ /\^\{\}$/) peeled[substr($2, 1, length($2)-3)] = $1; else tags[$2] = $1 }
  END {
    for (ref in tags) {
      target = (ref in peeled) ? peeled[ref] : tags[ref]
      if (target == commit) { print ref; exit }
    }
  }
' <<< "$refs")
if [[ -z $tag ]]; then
  echo "vendor/oh-my-pi $commit is not an upstream tag commit" >&2
  exit 1
fi

# Verify the remote target is really a commit, not a tag pointing to a tree/blob.
# Fetch only the matching tag and its shallow, blob-filtered history; no submodule checkout.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git init -q --bare "$tmp/repo"
git -C "$tmp/repo" fetch -q --depth=1 --filter=blob:none --no-tags "$upstream" "$tag:refs/tags/vendor-guard"
resolved=$(git -C "$tmp/repo" rev-parse --verify 'refs/tags/vendor-guard^{commit}')
if [[ $resolved != "$commit" ]]; then
  echo "Upstream tag $tag no longer resolves to $commit" >&2
  exit 1
fi
echo "vendor/oh-my-pi $commit matches upstream tag $tag"

# Local-only edits inside the submodule never sync via the parent repo (only the gitlink does).
# CI does not check out submodules, so this only fires on developer machines.
if [[ -e vendor/oh-my-pi/.git ]]; then
  dirty=$(git -C vendor/oh-my-pi status --porcelain)
  if [[ -n $dirty ]]; then
    echo 'vendor/oh-my-pi has local changes that cannot be synced to other machines:' >&2
    echo "$dirty" >&2
    echo 'Move them into omp-web packages, or discard: git -C vendor/oh-my-pi checkout . && git -C vendor/oh-my-pi clean -fd' >&2
    exit 1
  fi
fi
