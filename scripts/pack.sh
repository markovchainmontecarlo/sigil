#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p dist

name="$(bun -e 'const p = await import("./package.json", { with: { type: "json" } }); console.log(p.default.name.replace(/^@/, "").replace(/\//g, "-"));')"
version="$(bun -e 'const p = await import("./package.json", { with: { type: "json" } }); console.log(p.default.version);')"
tarball="dist/${name}-${version}.tgz"

bun pm pack --destination dist/

if [ ! -f "$tarball" ]; then
  tarball="$(find dist -maxdepth 1 -type f -name '*.tgz' -print | sort | tail -n 1)"
fi

tmp="$(mktemp -d)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT
tar -xzf "$tarball" -C "$tmp"
cp bun.lock "$tmp/package/bun.lock"
tar -czf "$tarball" -C "$tmp" package

printf '%s\n' "$tarball"
shasum -a 256 "$tarball" | tee "$tarball.sha256"
