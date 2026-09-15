#!/usr/bin/env bash
# Dev-only helper: make this checkout's tests resolve the DeepSeek Harness
# package closure from a local dsh installation, without vendoring anything.
#
#   npm run link:harness            # auto-detect from `command -v dsh`
#   npm run link:harness -- /path/to/node_modules/@deepseek-ai/dsh
#
# The symlink lands in ./node_modules (git-ignored).
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pkg_dir="${1:-}"

if [ -z "$pkg_dir" ]; then
	if ! command -v dsh >/dev/null 2>&1; then
		echo "dev-link-harness: dsh is not on PATH; pass the harness package dir explicitly" >&2
		exit 1
	fi
	pkg_dir="$(dirname "$(dirname "$(readlink -f "$(command -v dsh)")")")"
fi

closure="$pkg_dir/node_modules/@deepseek-ai"
if [ ! -d "$closure" ]; then
	echo "dev-link-harness: no @deepseek-ai closure under $pkg_dir" >&2
	exit 1
fi

mkdir -p "$repo/node_modules"
ln -sfn "$closure" "$repo/node_modules/@deepseek-ai"
echo "dev-link-harness: $repo/node_modules/@deepseek-ai -> $closure"
