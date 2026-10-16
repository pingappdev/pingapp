#!/usr/bin/env bash

assert_ci_invariant_profile() {
  local config_file="$1"
  if ! awk '
    /^\[profile\.ci\.invariant\]$/ { section = "invariant"; next }
    /^\[\[profile\.ci\.fs_permissions\]\]$/ { section = "fs"; next }
    /^\[/ { section = "" }
    section == "invariant" && /^[[:space:]]*runs[[:space:]]*=[[:space:]]*1024[[:space:]]*$/ { runs = 1 }
    section == "invariant" && /^[[:space:]]*depth[[:space:]]*=[[:space:]]*128[[:space:]]*$/ { depth = 1 }
    section == "invariant" && /^[[:space:]]*fail_on_revert[[:space:]]*=[[:space:]]*true[[:space:]]*$/ { fail_on_revert = 1 }
    section == "invariant" && /^[[:space:]]*failure_persist_dir[[:space:]]*=[[:space:]]*"\/ci-runtime\/cache\/invariant\/failures"[[:space:]]*$/ { failure_path = 1 }
    section == "fs" && /^[[:space:]]*access[[:space:]]*=[[:space:]]*"read-write"[[:space:]]*$/ { fs_write = 1 }
    section == "fs" && /^[[:space:]]*path[[:space:]]*=[[:space:]]*"\/ci-runtime\/evidence"[[:space:]]*$/ { fs_path = 1 }
    END { exit !(runs && depth && fail_on_revert && failure_path && fs_write && fs_path) }
  ' "$config_file"; then
    echo 'Required CI profile is 1024x128 with fail_on_revert, isolated failure persistence, and evidence-only write permission.' >&2
    return 1
  fi
}
