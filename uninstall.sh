#!/usr/bin/env bash
set -eu

usage='Usage: ./uninstall.sh [--dry-run|-n] [--all-homes] [--help|-h]'
help=0
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n|--all-homes) ;;
    --help|-h) help=1 ;;
    *) printf 'error: unknown argument: %s\n%s\n' "$arg" "$usage" >&2; exit 2 ;;
  esac
done
if [ "$help" -eq 1 ]; then
  printf '%s\n' "$usage"
  exit 0
fi

dir=${BASH_SOURCE[0]%/*}
[ "$dir" != "${BASH_SOURCE[0]}" ] || dir=.
exec bash "${dir:-/}/install.sh" uninstall "$@"
