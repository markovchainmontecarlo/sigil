#!/bin/sh
set -eu

# The installer fetches the latest release tarball and checksum by default.
# Set SIGIL_RELEASE_TARBALL and SIGIL_RELEASE_CHECKSUM to test a local artifact,
# or set RELEASE_REPO / RELEASE_TAG / RELEASE_ASSET_GLOB to override the GitHub
# source. The frozen production install is intentional: it materializes
# platform-native packages such as codex-acp and libsql from the packed
# lockfile after unpacking instead of trusting packed node_modules.
RELEASE_REPO="${RELEASE_REPO:-markovchainmontecarlo/sigil}"
RELEASE_TAG="${RELEASE_TAG:-}"
RELEASE_ASSET_GLOB="${RELEASE_ASSET_GLOB:-sigil-*.tgz}"
SIGIL_RELEASE_TARBALL="${SIGIL_RELEASE_TARBALL:-}"
SIGIL_RELEASE_CHECKSUM="${SIGIL_RELEASE_CHECKSUM:-}"
SIGIL_HOME="${SIGIL_HOME:-$HOME/.sigil}"
LIB_DIR="$SIGIL_HOME/lib"
SKILL_DIR="$SIGIL_HOME/skills"
BIN_DIR="$HOME/.local/bin"
MAN_DIR="$HOME/.local/share/man/man1"
CLAUDE_SKILL_DIR="$HOME/.claude/skills"
CODEX_SKILL_DIR="$HOME/.codex/skills"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing $1 on PATH. Install $1, then rerun this installer." >&2
    exit 1
  fi
}

need bun
need gh

link_managed_skill_into() {
  skill_dir="$1"
  name="$2"
  target="$skill_dir/$name"
  source="$SKILL_DIR/$name"

  [ -e "$source" ] || return 0

  mkdir -p "$skill_dir"
  rm -rf "$target"
  ln -s "$source" "$target"
}

link_managed_skill() {
  name="$1"

  link_managed_skill_into "$CLAUDE_SKILL_DIR" "$name"
  link_managed_skill_into "$CODEX_SKILL_DIR" "$name"
}

remove_obsolete_managed_link() {
  skill_dir="$1"
  name="$2"
  target="$skill_dir/$name"
  managed_source="$SKILL_DIR/$name"

  [ -L "$target" ] || return 0
  [ "$(readlink "$target")" = "$managed_source" ] || return 0
  [ ! -e "$managed_source" ] || return 0

  rm "$target"
}

remove_obsolete_managed_skill() {
  name="$1"

  remove_obsolete_managed_link "$CLAUDE_SKILL_DIR" "$name"
  remove_obsolete_managed_link "$CODEX_SKILL_DIR" "$name"
}

link_installed_document() {
  name="$1"
  source="$LIB_DIR/$name"
  target="$SIGIL_HOME/$name"

  [ -e "$source" ] || return 0

  rm -rf "$target"
  ln -s "$source" "$target"
}

tmp="$(mktemp -d)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT HUP INT TERM

tarball="$tmp/sigil.tgz"
checksum="$tmp/sigil.tgz.sha256"
if [ -n "$SIGIL_RELEASE_TARBALL" ] || [ -n "$SIGIL_RELEASE_CHECKSUM" ]; then
  if [ -z "$SIGIL_RELEASE_TARBALL" ] || [ -z "$SIGIL_RELEASE_CHECKSUM" ]; then
    echo "Set both SIGIL_RELEASE_TARBALL and SIGIL_RELEASE_CHECKSUM together." >&2
    exit 1
  fi
  cp "$SIGIL_RELEASE_TARBALL" "$tarball"
  cp "$SIGIL_RELEASE_CHECKSUM" "$checksum"
else
  release_args="--repo $RELEASE_REPO --pattern $RELEASE_ASSET_GLOB --pattern $RELEASE_ASSET_GLOB.sha256 --dir $tmp --clobber"
  if [ -n "$RELEASE_TAG" ]; then
    # shellcheck disable=SC2086
    gh release download "$RELEASE_TAG" $release_args >/dev/null 2>&1
  else
    # shellcheck disable=SC2086
    gh release download $release_args >/dev/null 2>&1
  fi
  downloaded_tgz="$(find "$tmp" -maxdepth 1 -type f -name "$RELEASE_ASSET_GLOB" | sort | tail -n 1)"
  downloaded_sha="$(find "$tmp" -maxdepth 1 -type f -name "$RELEASE_ASSET_GLOB.sha256" | sort | tail -n 1)"
  if [ -z "$downloaded_tgz" ] || [ -z "$downloaded_sha" ]; then
    echo "Failed to download release assets matching $RELEASE_ASSET_GLOB from $RELEASE_REPO." >&2
    exit 1
  fi
  tarball="$downloaded_tgz"
  checksum="$downloaded_sha"
fi

expected="$(awk '{print $1}' "$checksum")"
actual="$(shasum -a 256 "$tarball" | awk '{print $1}')"
if [ "$expected" != "$actual" ]; then
  echo "Checksum verification failed for $tarball" >&2
  exit 1
fi

mkdir -p "$SIGIL_HOME" "$BIN_DIR"
stage="$tmp/lib"
mkdir -p "$stage"
tar -xzf "$tarball" -C "$stage" --strip-components=1
(cd "$stage" && bun install --production --frozen-lockfile)
old="$tmp/old-lib"
old_skill_names="$tmp/old-skill-names"
if [ -d "$SKILL_DIR" ]; then
  find "$SKILL_DIR" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort > "$old_skill_names"
else
  : > "$old_skill_names"
fi
rm -rf "$old"
if [ -d "$LIB_DIR" ]; then mv "$LIB_DIR" "$old"; fi
mv "$stage" "$LIB_DIR"

if [ -d "$LIB_DIR/skills" ]; then
  rm -rf "$SKILL_DIR"
  mkdir -p "$SKILL_DIR"
  cp -R "$LIB_DIR"/skills/* "$SKILL_DIR/" 2>/dev/null || true
  for skill_path in "$SKILL_DIR"/*; do
    [ -d "$skill_path" ] || continue
    link_managed_skill "$(basename "$skill_path")"
  done
fi

while IFS= read -r name; do
  [ -n "$name" ] || continue
  remove_obsolete_managed_skill "$name"
done < "$old_skill_names"

link_installed_document "SIGIL_USAGE.md"
link_installed_document "ARCHITECTURE.md"
link_installed_document "README.md"
link_installed_document "docs"

if [ -f "$LIB_DIR/man/sigil.1" ]; then
  mkdir -p "$MAN_DIR"
  cp "$LIB_DIR/man/sigil.1" "$MAN_DIR/sigil.1"
fi

cat > "$BIN_DIR/sigil" <<'LAUNCHER'
#!/bin/sh
exec env bun "${SIGIL_HOME:-$HOME/.sigil}/lib/src/cli.js" "$@"
LAUNCHER
chmod +x "$BIN_DIR/sigil"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Add $BIN_DIR to PATH to run sigil from any shell." ;;
esac
