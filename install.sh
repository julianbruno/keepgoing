#!/usr/bin/env bash
# Install or remove keepgoing as a personal Pi package (Linux/systemd and macOS).
# Usage: ./install.sh [install|uninstall|status] [--dry-run] [--all-homes]
# --all-homes runs the action in every Pi home found at ~/.pi/agent and ~/.pi-*/agent.
set -euo pipefail

script_dir=${BASH_SOURCE[0]%/*}
[ "$script_dir" != "${BASH_SOURCE[0]}" ] || script_dir=.
# Preserve even a trailing newline so it can be rejected, not silently stripped.
ROOT="$(CDPATH= cd -P -- "${script_dir:-/}" && printf '%s.' "$PWD")"
ROOT=${ROOT%.}
ACTION="install"
DRY_RUN=0
ALL_HOMES=0

usage() {
  sed -n '2,4p' "$0" | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
  case "$arg" in
    install | uninstall | status) ACTION="$arg" ;;
    --dry-run | -n) DRY_RUN=1 ;;
    --all-homes) ALL_HOMES=1 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "error: unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

info() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# First top-level "version" string in package.json, without requiring node or jq.
package_version() {
  local version
  version="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/package.json" 2>/dev/null | sed -n '1p')" || version=""
  printf '%s\n' "${version:-unknown}"
}

# --all-homes children inherit KEEPGOING_INSTALL_CHILD so the version prints once.
PACKAGE_VERSION="$(package_version)"
[ -n "${KEEPGOING_INSTALL_CHILD:-}" ] || info "keepgoing $PACKAGE_VERSION"

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

# Display-only lookup for install/status. Never pass its result to pi remove.
installed_source() {
  awk -v root="$ROOT" '
    /^User packages:/ { personal = 1; next }
    /^[^ ]/ { personal = 0 }
    !personal { next }
    /^  [^ ]/ { source = substr($0, 3); if (source == root) { print source; exit } }
    /^    [^ ]/ && substr($0, 5) == root { print source; exit }
  '
}

# Pi lists a display label, then the installed path. Require a unique path row
# and independently resolve its personal label before using ROOT as the operand.
removal_target() {
  node -e '
    const fs = require("node:fs"), path = require("node:path");
    const { homedir } = require("node:os"), { fileURLToPath } = require("node:url");
    const root = process.argv[1];
    function refuse() { process.exit(1); }
    if (!path.isAbsolute(root) || root !== root.trim() || /[\x00-\x1f\x7f\ufffd]/.test(root)) refuse();
    function expand(s) {
      if (s === "~") return homedir();
      if (s.startsWith("~/")) return path.join(homedir(), s.slice(2));
      if (s.startsWith("file://")) return fileURLToPath(s);
      return s;
    }
    const base = expand(process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi/agent"));
    function localPath(s) {
      if (!s || s !== s.trim() || /[\x00-\x1f\x7f]/.test(s)) return null;
      if (/^[\w+.-]+:/.test(s) && !s.startsWith("file://")) return null;
      try { return path.resolve(base, expand(s)); } catch { return null; }
    }
    // stat follows links in every component. The device/file ID is only a veto:
    // an alternate spelling of the checkout is never a Pi removal operand.
    function identity(p) {
      const { dev, ino } = fs.statSync(p, { bigint: true });
      if (!ino) refuse();
      return `${dev}:${ino}`;
    }
    let checkout;
    try { checkout = identity(root); } catch { refuse(); }
    function rejectAlias(p, reportedInstalled) {
      if (!path.isAbsolute(p)) refuse();
      if (p === root) return;
      try { if (identity(p) === checkout) refuse(); }
      catch (e) {
        // Pi omits the installed-path row for stale declarations.
        if (reportedInstalled || !(e.code === "ENOENT" || e.code === "ENOTDIR")) refuse();
      }
    }
    const rows = fs.readFileSync(0, "utf8").split("\n"), suffix = " (filtered)";
    let personal = false, matches = 0, personalPaths = 0, paths = 0;
    for (const [i, line] of rows.entries()) {
      if (/^\S/.test(line)) personal = line === "User packages:";
      if (line === "    " + root) { paths++; if (personal) personalPaths++; }
      // Check installed paths even when a managed or oddly spaced label cannot prove ownership.
      if (personal && /^    \S/.test(line) && path.isAbsolute(line.slice(4))) rejectAlias(line.slice(4), true);
      if (!personal || !/^  \S/.test(line)) continue;
      const label = line.slice(2), candidates = [localPath(label)];
      if (label.endsWith(suffix)) candidates.push(localPath(label.slice(0, -suffix.length)));
      const installed = rows[i + 1]?.match(/^    (\S.*)$/)?.[1];
      if (installed && !path.isAbsolute(installed)) refuse();
      if (!installed || !candidates.includes(installed)) {
        for (const p of candidates) if (p) rejectAlias(p, false);
      }
      if (installed !== root && !candidates.includes(root)) continue;
      // The suffix might be part of a real filename. The path row must settle it.
      if (!installed || !candidates.includes(installed)) refuse();
      if (installed === root) matches++;
    }
    if (matches !== personalPaths || (matches && paths !== 1)) refuse();
    if (matches) process.stdout.write(root);
  ' "$ROOT"
}

check_platform() {
  case "$(uname -s)" in
    Linux)
      command -v systemd-inhibit >/dev/null 2>&1 \
        || die "systemd-inhibit not found; Linux without systemd/logind is not supported"
      command -v tail >/dev/null 2>&1 || die "tail not found"
      ;;
    Darwin)
      command -v caffeinate >/dev/null 2>&1 || die "caffeinate not found"
      ;;
    *)
      die "unsupported platform $(uname -s); on Windows use install.ps1"
      ;;
  esac
}

# Each Pi home (for example the ODD lanes ~/.pi-opus) keeps its own package list,
# so run this script once per home with PI_CODING_AGENT_DIR pointing at it.
if [ "$ALL_HOMES" -eq 1 ]; then
  if [ -n "${PI_CODING_AGENT_DIR:-}" ]; then
    printf 'error: --all-homes cannot be combined with PI_CODING_AGENT_DIR\n' >&2
    exit 2
  fi
  HOMES=()
  for dir in "${HOME:?HOME is not set}/.pi/agent" "$HOME"/.pi-*/agent; do
    [ -d "$dir" ] && HOMES+=("$dir")
  done
  [ "${#HOMES[@]}" -gt 0 ] || die "no Pi homes found (looked for $HOME/.pi/agent and $HOME/.pi-*/agent)"
  CHILD_ARGS=("$ACTION")
  [ "$DRY_RUN" -eq 1 ] && CHILD_ARGS+=(--dry-run)
  FAILED=()
  for dir in "${HOMES[@]}"; do
    info "Pi home: $dir"
    KEEPGOING_INSTALL_CHILD=1 PI_CODING_AGENT_DIR="$dir" bash "$ROOT/install.sh" "${CHILD_ARGS[@]}" || FAILED+=("$dir")
  done
  if [ "${#FAILED[@]}" -gt 0 ]; then
    printf 'error: %s of %s Pi homes failed: %s\n' "${#FAILED[@]}" "${#HOMES[@]}" "${FAILED[*]}" >&2
    exit 1
  fi
  info "${#HOMES[@]} Pi homes processed"
  exit 0
fi

command -v pi >/dev/null 2>&1 || die "pi CLI not found in PATH"
[ -f "$ROOT/package.json" ] && [ -f "$ROOT/extensions/keepgoing.ts" ] \
  || die "run this script from inside the keepgoing checkout"
if [ "$ACTION" = uninstall ]; then
  LIST="$(pi list --no-approve)" || die "pi list failed; no package changes made"
  command -v node >/dev/null 2>&1 || die "node not found; cannot verify checkout identity"
  SOURCE="$(printf '%s\n' "$LIST" | removal_target)" || die "unsafe or ambiguous checkout identity; no package changes made"
else
  LIST="$(pi list)" || die "pi list failed; no package changes made"
  SOURCE="$(printf '%s\n' "$LIST" | installed_source)"
fi

case "$ACTION" in
  status)
    if [ -n "$SOURCE" ]; then
      info "keepgoing is installed from $ROOT"
    else
      info "keepgoing is not installed from $ROOT"
    fi
    ;;

  install)
    check_platform
    if [ -n "$SOURCE" ]; then
      info "keepgoing already installed from $ROOT"
    else
      info "installing keepgoing $PACKAGE_VERSION from $ROOT"
      run pi install "$ROOT"
    fi
    info "done. Restart Pi (or run /reload) and check /jb:keepgoing and /jb:keepgoing inhibit."
    info "keep this checkout in place: Pi loads the package from $ROOT"
    ;;

  uninstall)
    if [ -n "$SOURCE" ]; then
      info "removing keepgoing $PACKAGE_VERSION ($ROOT)"
      run pi remove "$ROOT" --no-approve
      info "done. Restart Pi (or run /reload)."
    else
      info "keepgoing is not installed from $ROOT; nothing to do"
    fi
    ;;
esac
