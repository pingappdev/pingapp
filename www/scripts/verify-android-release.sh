#!/usr/bin/env bash
set -euo pipefail

# This verifier is deliberately pinned to the published 0.1.0 APK. Update its
# constants only when adding a separately versioned release record.
readonly RELEASE_VERSION="0.1.0"
readonly EXPECTED_SIZE_BYTES="8884986"
readonly EXPECTED_SHA256="7a3d60d1639778319c1378248525fba54cede72966f324f3ad3befed4ceaaec6"
readonly EXPECTED_CERT_SHA256="ae2151813f4a06189870dacd737c686a98e0f63c5ddedfd966603a5994acc965"

fail() {
  printf 'Verification failed: %s\n' "$1" >&2
  exit 1
}

if [[ $# -ne 1 ]]; then
  printf 'Usage: %s <downloaded-pingapp.apk>\n' "$0" >&2
  exit 2
fi

apk_path=$1
[[ -f "$apk_path" ]] || fail "APK file not found: $apk_path"

command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required"
command -v stat >/dev/null 2>&1 || fail "stat is required"

apksigner_path=""
if command -v apksigner >/dev/null 2>&1; then
  apksigner_path=$(command -v apksigner)
else
  for sdk_root in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}"; do
    [[ -n "$sdk_root" && -d "$sdk_root/build-tools" ]] || continue
    candidate=$(find "$sdk_root/build-tools" -maxdepth 2 -type f -name apksigner -print 2>/dev/null | sort -V | tail -n 1)
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      apksigner_path=$candidate
      break
    fi
  done
fi
[[ -n "$apksigner_path" ]] || fail "Android SDK Build Tools apksigner is required"

actual_size=$(stat -c '%s' -- "$apk_path") || fail "could not read APK size"
[[ "$actual_size" == "$EXPECTED_SIZE_BYTES" ]] ||
  fail "pinned $RELEASE_VERSION APK must be $EXPECTED_SIZE_BYTES bytes (got $actual_size)"

actual_sha256=$(sha256sum -- "$apk_path" | awk '{ print $1 }') || fail "could not compute APK SHA-256"
[[ "$actual_sha256" == "$EXPECTED_SHA256" ]] ||
  fail "pinned $RELEASE_VERSION APK SHA-256 does not match"

signer_output=$("$apksigner_path" verify --verbose --print-certs "$apk_path") ||
  fail "apksigner could not verify this APK"
grep -q '^Verifies$' <<<"$signer_output" || fail "apksigner did not report a valid signature"
grep -q '^Number of signers: 1$' <<<"$signer_output" || fail "expected exactly one APK signer"

actual_cert_sha256=$(sed -n 's/^[[:space:]]*Signer #1 certificate SHA-256 digest:[[:space:]]*//p' <<<"$signer_output" |
  head -n 1 | tr -d ':[:space:]' | tr '[:upper:]' '[:lower:]')
[[ "$actual_cert_sha256" == "$EXPECTED_CERT_SHA256" ]] ||
  fail "APK signing certificate SHA-256 does not match pinned $RELEASE_VERSION release"

printf 'Verified pinned Android release %s\n' "$RELEASE_VERSION"
printf 'APK bytes: %s\n' "$actual_size"
printf 'APK SHA-256: %s\n' "$actual_sha256"
printf 'Signing certificate SHA-256: %s\n' "$actual_cert_sha256"
printf 'This verifies file identity and signing, not source or build provenance.\n'
