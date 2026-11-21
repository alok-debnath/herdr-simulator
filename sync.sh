#!/bin/sh
# Copies this repo's mods and layout into Herdr, which reloads them. Make changes
# here, then run this. A symlink won't do: Herdr loads a linked mod's code but not
# its icons.
#
#   ./sync.sh          repo -> Herdr, then herdr-app check each mod
#   ./sync.sh --pull   Herdr -> repo, for a change made in Herdr's copy
#   ./sync.sh --dry    show what either direction would change, change nothing
#
# Files Herdr writes into every mod folder (the .d.ts files, jsconfig.json) and the
# screen frames are never copied or deleted.
set -euf  # -f: no globbing, so the *.jpg exclude reaches rsync as written
cd "$(dirname "$0")"
home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
mods="herdr-simulator herdr-simulator-screen tabs-herdr-simulator"
layout="layouts/herdr-simulator.json"
skip="--exclude gpui-kit.d.ts --exclude herdr.d.ts --exclude jsconfig.json --exclude *.jpg"

direction=push
dry=""
for arg in "$@"; do
  case "$arg" in
    --pull) direction=pull ;;
    --dry) dry="--dry-run" ;;
    *) echo "usage: $0 [--pull] [--dry]" >&2; exit 2 ;;
  esac
done

for mod in $mods; do
  if [ "$direction" = push ]; then
    from="mods/$mod/"; to="$home/mods/$mod/"
  else
    from="$home/mods/$mod/"; to="mods/$mod/"
  fi
  # --itemize-changes lists each file it copies or deletes.
  # shellcheck disable=SC2086
  rsync -a --delete --itemize-changes $dry $skip "$from" "$to"
done

if [ "$direction" = push ]; then
  rsync -a --itemize-changes $dry "$layout" "$home/$layout"
else
  rsync -a --itemize-changes $dry "$home/$layout" "$layout"
fi

if [ "$direction" = push ] && [ -z "$dry" ]; then
  for mod in $mods; do herdr-app check "$home/mods/$mod" 2>&1 | tail -1; done
fi
