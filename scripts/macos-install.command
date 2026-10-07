#!/bin/bash
set -euo pipefail
package_dir="$(cd "$(dirname "$0")" && pwd)"
work_dir="$(/usr/bin/mktemp -d /tmp/git-view-package.XXXXXX)"
trap '/bin/rm -rf "$work_dir"' EXIT
bundle_dir="$work_dir/apps/desktop/src-tauri/target/release/bundle/macos"
/bin/mkdir -p "$bundle_dir" "$work_dir/scripts"
/usr/bin/ditto -x -k "$package_dir/Git-View.app.zip" "$bundle_dir"
/bin/cp "$package_dir/.installer/install-desktop.mjs" "$work_dir/scripts/"
/bin/cp "$package_dir/.installer/verify-installed.mjs" "$work_dir/scripts/"
/bin/cp "$package_dir/.installer/tauri.conf.json" "$work_dir/apps/desktop/src-tauri/"
runtime="$bundle_dir/Git View.app/Contents/Resources/runtime/node"
if [[ "${1:-}" == "--verify-only" ]]; then
  "$runtime" "$work_dir/scripts/verify-installed.mjs" --app "$bundle_dir/Git View.app"
else
  "$runtime" "$work_dir/scripts/install-desktop.mjs" "$@"
  if [[ "${1:-}" != "--dry-run" && "${1:-}" != "--check-ready" ]]; then
    /usr/bin/open "$HOME/Applications/Git View.app"
    printf '\nInstalled to ~/Applications/Git View.app. You can close this window and eject the disk image.\n'
  fi
fi
