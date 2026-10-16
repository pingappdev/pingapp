#!/usr/bin/env bash

assert_ci_invariant_profile() {
  local config_file="$1"
  if ! awk '
    /^\[profile\.ci\.invariant\]$/ { section = 1; next }
    /^\[/ { if (section) exit }
    section && /^[[:space:]]*runs[[:space:]]*=[[:space:]]*1024[[:space:]]*$/ { runs = 1 }
    section && /^[[:space:]]*depth[[:space:]]*=[[:space:]]*128[[:space:]]*$/ { depth = 1 }
    section && /^[[:space:]]*fail_on_revert[[:space:]]*=[[:space:]]*true[[:space:]]*$/ { fail_on_revert = 1 }
    END { exit !(section && runs && depth && fail_on_revert) }
  ' "$config_file"; then
    echo 'Required [profile.ci.invariant] settings are runs=1024, depth=128, fail_on_revert=true.' >&2
    return 1
  fi
}
