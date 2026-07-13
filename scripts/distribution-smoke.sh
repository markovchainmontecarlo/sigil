#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

tmp="$(mktemp -d)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

home_dir="$tmp/home"
mkdir -p "$home_dir/.local/bin"
mkdir -p "$home_dir/.claude/skills"
mkdir -p "$home_dir/.codex/skills"

bash scripts/pack.sh >/tmp/sigil-pack.out
tarball="$(tail -2 /tmp/sigil-pack.out | head -1)"
checksum="$tarball.sha256"

run_install() {
  HOME="$home_dir" \
  SIGIL_HOME="$home_dir/.sigil" \
  SIGIL_RELEASE_TARBALL="$PWD/$tarball" \
  SIGIL_RELEASE_CHECKSUM="$PWD/$checksum" \
  sh scripts/install.sh
}

echo "=== fresh install ==="
run_install

test -x "$home_dir/.local/bin/sigil"
test -f "$home_dir/.sigil/lib/src/cli.ts"
test -f "$home_dir/.sigil/lib/src/dashboard/public/index.html"
test -f "$home_dir/.sigil/lib/bun.lock"
test -f "$home_dir/.sigil/skills/sigil/SKILL.md"
test -f "$home_dir/.sigil/skills/sigil-authoring/SKILL.md"
test -f "$home_dir/.sigil/skills/sigil-dispatch/SKILL.md"
test -f "$home_dir/.sigil/skills/sigil-refactor/SKILL.md"
test -f "$home_dir/.sigil/skills/sigil-migration/SKILL.md"
test ! -e "$home_dir/.sigil/skills/sigil-plan"
test -L "$home_dir/.sigil/SIGIL_USAGE.md"
test -f "$home_dir/.sigil/SIGIL_USAGE.md"
test -L "$home_dir/.sigil/docs"
test -f "$home_dir/.sigil/docs/explanation/workflow-patterns.md"
test -f "$home_dir/.local/share/man/man1/sigil.1"
test -L "$home_dir/.claude/skills/sigil"
test "$(readlink "$home_dir/.claude/skills/sigil")" = "$home_dir/.sigil/skills/sigil"
test -L "$home_dir/.claude/skills/sigil-authoring"
test "$(readlink "$home_dir/.claude/skills/sigil-authoring")" = "$home_dir/.sigil/skills/sigil-authoring"
test -L "$home_dir/.codex/skills/sigil"
test "$(readlink "$home_dir/.codex/skills/sigil")" = "$home_dir/.sigil/skills/sigil"
test -L "$home_dir/.codex/skills/sigil-authoring"
test "$(readlink "$home_dir/.codex/skills/sigil-authoring")" = "$home_dir/.sigil/skills/sigil-authoring"
for name in sigil-dispatch sigil-refactor sigil-migration; do
  test -L "$home_dir/.claude/skills/$name"
  test "$(readlink "$home_dir/.claude/skills/$name")" = "$home_dir/.sigil/skills/$name"
  test -L "$home_dir/.codex/skills/$name"
  test "$(readlink "$home_dir/.codex/skills/$name")" = "$home_dir/.sigil/skills/$name"
done
HOME="$home_dir" SIGIL_HOME="$home_dir/.sigil" "$home_dir/.local/bin/sigil" --help >/tmp/sigil-smoke-help.txt

echo "=== update install ==="
mkdir -p "$home_dir/.sigil/skills/stale-skill"
printf 'stale\n' > "$home_dir/.sigil/skills/stale-skill/OLD.md"
mkdir -p "$home_dir/.sigil/skills/sigil-plan"
printf 'obsolete\n' > "$home_dir/.sigil/skills/sigil-plan/SKILL.md"
ln -s "$home_dir/.sigil/skills/sigil-plan" "$home_dir/.claude/skills/sigil-plan"
ln -s "$home_dir/.sigil/skills/sigil-plan" "$home_dir/.codex/skills/sigil-plan"
mkdir -p "$home_dir/.claude/skills/user-skill" "$home_dir/.codex/skills/user-skill"
printf 'user owned\n' > "$home_dir/.claude/skills/user-skill/SKILL.md"
printf 'user owned\n' > "$home_dir/.codex/skills/user-skill/SKILL.md"
printf 'corrupt\n' > "$home_dir/.sigil/lib/src/cli.ts"
rm -rf "$home_dir/.claude/skills/sigil"
mkdir -p "$home_dir/.claude/skills/sigil"
printf 'stale\n' > "$home_dir/.claude/skills/sigil/OLD.md"
rm -rf "$home_dir/.claude/skills/sigil-authoring"
mkdir -p "$home_dir/.claude/skills/sigil-authoring"
printf 'stale\n' > "$home_dir/.claude/skills/sigil-authoring/OLD.md"
rm -rf "$home_dir/.codex/skills/sigil"
mkdir -p "$home_dir/.codex/skills/sigil"
printf 'stale\n' > "$home_dir/.codex/skills/sigil/OLD.md"
rm -rf "$home_dir/.codex/skills/sigil-authoring"
mkdir -p "$home_dir/.codex/skills/sigil-authoring"
printf 'stale\n' > "$home_dir/.codex/skills/sigil-authoring/OLD.md"
run_install

test ! -e "$home_dir/.sigil/skills/stale-skill"
test ! -e "$home_dir/.sigil/skills/sigil-plan"
test ! -e "$home_dir/.claude/skills/sigil-plan"
test ! -e "$home_dir/.codex/skills/sigil-plan"
test -f "$home_dir/.claude/skills/user-skill/SKILL.md"
test -f "$home_dir/.codex/skills/user-skill/SKILL.md"
grep -q '#!/usr/bin/env bun' "$home_dir/.sigil/lib/src/cli.ts"
test -f "$home_dir/.sigil/skills/sigil/SKILL.md"
test -f "$home_dir/.sigil/skills/sigil-authoring/SKILL.md"
test -f "$home_dir/.sigil/skills/sigil-dispatch/SKILL.md"
test -f "$home_dir/.sigil/skills/sigil-refactor/SKILL.md"
test -f "$home_dir/.sigil/skills/sigil-migration/SKILL.md"
test -f "$home_dir/.sigil/SIGIL_USAGE.md"
test -f "$home_dir/.sigil/docs/explanation/workflow-patterns.md"
test -f "$home_dir/.local/share/man/man1/sigil.1"
test -L "$home_dir/.claude/skills/sigil"
test "$(readlink "$home_dir/.claude/skills/sigil")" = "$home_dir/.sigil/skills/sigil"
test -L "$home_dir/.claude/skills/sigil-authoring"
test "$(readlink "$home_dir/.claude/skills/sigil-authoring")" = "$home_dir/.sigil/skills/sigil-authoring"
test -L "$home_dir/.codex/skills/sigil"
test "$(readlink "$home_dir/.codex/skills/sigil")" = "$home_dir/.sigil/skills/sigil"
test -L "$home_dir/.codex/skills/sigil-authoring"
test "$(readlink "$home_dir/.codex/skills/sigil-authoring")" = "$home_dir/.sigil/skills/sigil-authoring"
for name in sigil-dispatch sigil-refactor sigil-migration; do
  test -L "$home_dir/.claude/skills/$name"
  test "$(readlink "$home_dir/.claude/skills/$name")" = "$home_dir/.sigil/skills/$name"
  test -L "$home_dir/.codex/skills/$name"
  test "$(readlink "$home_dir/.codex/skills/$name")" = "$home_dir/.sigil/skills/$name"
done
HOME="$home_dir" SIGIL_HOME="$home_dir/.sigil" "$home_dir/.local/bin/sigil" --help >/tmp/sigil-smoke-help-after-update.txt

echo "distribution smoke passed"
