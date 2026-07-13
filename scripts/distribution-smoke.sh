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

tarball="${1:?installer archive path required}"
checksum="${2:?installer checksum path required}"

run_install() {
  HOME="$home_dir" \
  SIGIL_HOME="$home_dir/.sigil" \
  SIGIL_RELEASE_TARBALL="$(cd "$(dirname "$tarball")" && pwd)/$(basename "$tarball")" \
  SIGIL_RELEASE_CHECKSUM="$(cd "$(dirname "$checksum")" && pwd)/$(basename "$checksum")" \
  sh scripts/install.sh
}

echo "=== fresh install ==="
run_install

test -x "$home_dir/.local/bin/sigil"
test -f "$home_dir/.sigil/lib/src/cli.js"
test -f "$home_dir/.sigil/lib/src/cli.d.ts"
test -f "$home_dir/.sigil/lib/src/index.js"
test -f "$home_dir/.sigil/lib/src/index.d.ts"
test -f "$home_dir/.sigil/lib/resources/dashboard/public/index.html"
test -f "$home_dir/.sigil/lib/resources-manifest.json"
test -f "$home_dir/.sigil/lib/schemas/task-graph.schema.json"
test -f "$home_dir/.sigil/lib/bun.lock"
test -f "$home_dir/.sigil/skills/sigil/SKILL.md"
test -f "$home_dir/.sigil/skills/sigil-authoring/SKILL.md"
test -f "$home_dir/.sigil/skills/sigil-dispatch/SKILL.md"
test -f "$home_dir/.sigil/skills/sigil-refactor/SKILL.md"
test -f "$home_dir/.sigil/skills/sigil-migration/SKILL.md"
test -f "$home_dir/.sigil/skills/sigil-task-graph/SKILL.md"
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
for name in sigil-dispatch sigil-refactor sigil-migration sigil-task-graph; do
  test -L "$home_dir/.claude/skills/$name"
  test "$(readlink "$home_dir/.claude/skills/$name")" = "$home_dir/.sigil/skills/$name"
  test -L "$home_dir/.codex/skills/$name"
  test "$(readlink "$home_dir/.codex/skills/$name")" = "$home_dir/.sigil/skills/$name"
done
HOME="$home_dir" SIGIL_HOME="$home_dir/.sigil" "$home_dir/.local/bin/sigil" --help >"$tmp/sigil-smoke-help.txt"
HOME="$home_dir" SIGIL_HOME="$home_dir/.sigil" "$home_dir/.local/bin/sigil" task-graph schema > "$tmp/installed-task-graph.schema.json"
cmp "$tmp/installed-task-graph.schema.json" "$home_dir/.sigil/lib/schemas/task-graph.schema.json"
(cd "$home_dir/.sigil/lib" && bun -e 'await import("sigil"); await import("sigil/contracts"); await import("sigil/server")')
! grep -R 'src/cli\.ts\|src/index\.ts' "$home_dir/.local/bin/sigil" "$home_dir/.sigil/lib/src" >/dev/null

repo="$tmp/repo"
run_dir="$tmp/detached-run"
workflow="$tmp/workflow.ts"
mkdir -p "$repo"
cat > "$workflow" <<'WORKFLOW'
import { sigil } from "sigil";

export default sigil("installed-smoke", async (ctx, input: { repo: string }) => {
  await ctx.observe("installed-workflow");
  return { repo: input.repo, installed: true };
});
WORKFLOW
HOME="$home_dir" SIGIL_HOME="$home_dir/.sigil" "$home_dir/.local/bin/sigil" run-sigil \
  --repo "$repo" \
  --file "$workflow" \
  --run-dir "$run_dir" \
  --persistence ephemeral >"$tmp/sigil-smoke-run.txt"
for _ in $(seq 1 100); do
  state="$(bun -e 'const value = await Bun.file(process.argv[1]).json(); console.log(value.state)' "$run_dir/status.json" 2>/dev/null || true)"
  [ "$state" = "succeeded" ] && break
  [ "$state" = "failed" ] && { cat "$run_dir/run.log" >&2; exit 1; }
  sleep 0.1
done
test "$state" = "succeeded"
grep -q 'installed-workflow' "$run_dir/events.jsonl"
grep -q '"installed": true' "$run_dir/result.json"
test -f "$run_dir/run.log"

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
printf 'corrupt\n' > "$home_dir/.sigil/lib/src/cli.js"
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
grep -q '#!/usr/bin/env bun' "$home_dir/.sigil/lib/src/cli.js"
test -f "$home_dir/.sigil/skills/sigil/SKILL.md"
test -f "$home_dir/.sigil/skills/sigil-authoring/SKILL.md"
test -f "$home_dir/.sigil/skills/sigil-dispatch/SKILL.md"
test -f "$home_dir/.sigil/skills/sigil-refactor/SKILL.md"
test -f "$home_dir/.sigil/skills/sigil-migration/SKILL.md"
test -f "$home_dir/.sigil/skills/sigil-task-graph/SKILL.md"
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
for name in sigil-dispatch sigil-refactor sigil-migration sigil-task-graph; do
  test -L "$home_dir/.claude/skills/$name"
  test "$(readlink "$home_dir/.claude/skills/$name")" = "$home_dir/.sigil/skills/$name"
  test -L "$home_dir/.codex/skills/$name"
  test "$(readlink "$home_dir/.codex/skills/$name")" = "$home_dir/.sigil/skills/$name"
done
HOME="$home_dir" SIGIL_HOME="$home_dir/.sigil" "$home_dir/.local/bin/sigil" --help >"$tmp/sigil-smoke-help-after-update.txt"

echo "distribution smoke passed"
