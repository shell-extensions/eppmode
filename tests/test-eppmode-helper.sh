#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
helper="${repo_dir}/tools/eppmode-helper"
test_root="$(mktemp -d)"
trap 'rm -rf "${test_root}"' EXIT

mkdir -p "${test_root}/bin"
cat > "${test_root}/bin/gdbus" <<'EOF'
#!/bin/sh
case "${MOCK_UPOWER:-failure}" in
  low)
    printf "%s\n" "({'Percentage': <15.0>, 'State': <uint32 2>},)"
    ;;
  *)
    exit 1
    ;;
esac
EOF
cat > "${test_root}/bin/systemctl" <<'EOF'
#!/bin/sh
if [ "${MOCK_PPD_ACTIVE:-0}" = "1" ] &&
  [ "$1" = "is-active" ] &&
  [ "$2" = "--quiet" ] &&
  [ "$3" = "power-profiles-daemon.service" ]; then
  exit 0
fi
exit 3
EOF
cat > "${test_root}/bin/powerprofilesctl" <<'EOF'
#!/bin/sh
[ "$1" = "set" ] || exit 2
[ "${MOCK_PPD_FAIL:-0}" != "1" ] || exit 1
printf '%s\n' "$2" > /var/lib/eppmode/ppd-profile
EOF
printf '#!/bin/sh\nexit 0\n' > "${test_root}/bin/logger"
chmod +x \
  "${test_root}/bin/gdbus" \
  "${test_root}/bin/logger" \
  "${test_root}/bin/powerprofilesctl" \
  "${test_root}/bin/systemctl"

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

assert_eq() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "${actual}" != "${expected}" ]]; then
    printf 'not ok - %s\nexpected: %q\nactual:   %q\n' \
      "${label}" "${expected}" "${actual}" >&2
    exit 1
  fi
}

state_text() {
  printf 'SELECTED=%s\nAPPLIED=%s\nLOCK=%s\nSAFETY=%s\n' \
    "$1" "$2" "$3" "$4"
}

write_state() {
  state_text "$@" > "${test_root}/var/lib/eppmode/state"
}

setup_fixture() {
  rm -rf "${test_root:?}/sys" "${test_root:?}/var"
  mkdir -p \
    "${test_root}/sys/devices/system/cpu/cpu0/cpufreq" \
    "${test_root}/sys/devices/system/cpu/cpu1/cpufreq" \
    "${test_root}/sys/firmware/acpi" \
    "${test_root}/var/lib/eppmode"

  for cpu in cpu0 cpu1; do
    printf '%s\n' 'power balance_power balance_performance performance' \
      > "${test_root}/sys/devices/system/cpu/${cpu}/cpufreq/energy_performance_available_preferences"
    printf '%s\n' balance_performance \
      > "${test_root}/sys/devices/system/cpu/${cpu}/cpufreq/energy_performance_preference"
  done
  printf '%s\n' 'low-power balanced performance' \
    > "${test_root}/sys/firmware/acpi/platform_profile_choices"
  printf '%s\n' balanced > "${test_root}/sys/firmware/acpi/platform_profile"
  write_state balanced-performance balanced-performance 0 0
}

run_helper() {
  local sys_mode="$1"
  shift
  local bind_option=--bind
  if [[ "${sys_mode}" == ro ]]; then
    bind_option=--ro-bind
  fi

  bwrap \
    --die-with-parent \
    --unshare-user \
    --uid 0 \
    --gid 0 \
    --ro-bind / / \
    --dev /dev \
    "${bind_option}" "${test_root}/sys" /sys \
    --bind "${test_root}/var" /var \
    --setenv PATH "${test_root}/bin:/usr/bin:/bin" \
    --setenv EPPMODE_PLATFORM_DELAY 0 \
    "${helper}" "$@"
}

test_successful_set_updates_hardware_and_state() {
  setup_fixture

  run_helper rw set performance

  assert_eq state \
    "$(state_text performance performance 0 0)" \
    "$(cat "${test_root}/var/lib/eppmode/state")"
  for cpu in cpu0 cpu1; do
    assert_eq "${cpu} EPP" performance \
      "$(cat "${test_root}/sys/devices/system/cpu/${cpu}/cpufreq/energy_performance_preference")"
  done
  assert_eq platform_profile performance \
    "$(cat "${test_root}/sys/firmware/acpi/platform_profile")"
}

test_failed_write_preserves_state() {
  setup_fixture
  local before
  before="$(cat "${test_root}/var/lib/eppmode/state")"

  if run_helper ro set performance >/dev/null 2>&1; then
    fail 'read-only hardware write unexpectedly succeeded'
  fi

  assert_eq 'state after failed write' "${before}" \
    "$(cat "${test_root}/var/lib/eppmode/state")"
}

test_unsupported_epp_preserves_state() {
  setup_fixture
  printf '%s\n' 'power balance_power balance_performance' \
    > "${test_root}/sys/devices/system/cpu/cpu0/cpufreq/energy_performance_available_preferences"
  local before
  before="$(cat "${test_root}/var/lib/eppmode/state")"

  if run_helper rw set performance >/dev/null 2>&1; then
    fail 'unsupported EPP preference unexpectedly succeeded'
  fi

  assert_eq 'state after unsupported EPP' "${before}" \
    "$(cat "${test_root}/var/lib/eppmode/state")"
}

test_missing_platform_profile_is_optional() {
  setup_fixture
  rm -rf "${test_root}/sys/firmware/acpi"

  run_helper rw set power-saver

  assert_eq 'EPP-only state' \
    "$(state_text power-saver power-saver 0 0)" \
    "$(cat "${test_root}/var/lib/eppmode/state")"
  assert_eq 'EPP-only hardware' power \
    "$(cat "${test_root}/sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference")"
}

test_unstable_platform_profile_fails_without_state_update() {
  setup_fixture
  rm "${test_root}/sys/firmware/acpi/platform_profile"
  ln -s /dev/null "${test_root}/sys/firmware/acpi/platform_profile"
  local before
  before="$(cat "${test_root}/var/lib/eppmode/state")"

  if run_helper rw set power-saver >/dev/null 2>&1; then
    fail 'unstable platform_profile unexpectedly succeeded'
  fi

  assert_eq 'state after unstable platform_profile' "${before}" \
    "$(cat "${test_root}/var/lib/eppmode/state")"
}

test_active_ppd_is_synchronized_to_base_profile() {
  local mode expected
  while read -r mode expected; do
    setup_fixture

    EPPMODE_PPD_DELAY=0 MOCK_PPD_ACTIVE=1 run_helper rw set "${mode}"

    assert_eq "PPD profile for ${mode}" "${expected}" \
      "$(cat "${test_root}/var/lib/eppmode/ppd-profile")"
  done <<'EOF'
power-saver power-saver
balanced-powersave balanced
balanced-performance balanced
performance performance
EOF
}

test_ppd_sync_failure_preserves_hardware_and_state() {
  setup_fixture
  local before_state before_epp
  before_state="$(cat "${test_root}/var/lib/eppmode/state")"
  before_epp="$(cat "${test_root}/sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference")"

  if EPPMODE_PPD_DELAY=0 MOCK_PPD_ACTIVE=1 MOCK_PPD_FAIL=1 \
    run_helper rw set performance >/dev/null 2>&1; then
    fail 'failed PPD synchronization unexpectedly succeeded'
  fi

  assert_eq 'state after failed PPD synchronization' "${before_state}" \
    "$(cat "${test_root}/var/lib/eppmode/state")"
  assert_eq 'EPP after failed PPD synchronization' "${before_epp}" \
    "$(cat "${test_root}/sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference")"
}

test_unlocked_platform_drift_adopts_balanced_performance() {
  setup_fixture
  write_state power-saver power-saver 0 0
  for cpu in cpu0 cpu1; do
    printf '%s\n' power \
      > "${test_root}/sys/devices/system/cpu/${cpu}/cpufreq/energy_performance_preference"
  done
  printf '%s\n' balanced > "${test_root}/sys/firmware/acpi/platform_profile"

  run_helper rw reassert

  assert_eq 'state after unlocked balanced drift' \
    "$(state_text balanced-performance balanced-performance 0 0)" \
    "$(cat "${test_root}/var/lib/eppmode/state")"
  assert_eq 'EPP after unlocked balanced drift' balance_performance \
    "$(cat "${test_root}/sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference")"
  assert_eq 'platform after unlocked balanced drift' balanced \
    "$(cat "${test_root}/sys/firmware/acpi/platform_profile")"
}

test_unlocked_balanced_power_epp_remains_exact() {
  setup_fixture
  write_state balanced-powersave balanced-powersave 0 0
  for cpu in cpu0 cpu1; do
    printf '%s\n' balance_power \
      > "${test_root}/sys/devices/system/cpu/${cpu}/cpufreq/energy_performance_preference"
  done

  run_helper rw reassert

  assert_eq 'exact balanced-powersave state' \
    "$(state_text balanced-powersave balanced-powersave 0 0)" \
    "$(cat "${test_root}/var/lib/eppmode/state")"
}

test_locked_platform_drift_restores_power_saver() {
  setup_fixture
  write_state power-saver power-saver 1 0

  run_helper rw reassert

  assert_eq 'locked power-saver state' \
    "$(state_text power-saver power-saver 1 0)" \
    "$(cat "${test_root}/var/lib/eppmode/state")"
  assert_eq 'locked power-saver EPP' power \
    "$(cat "${test_root}/sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference")"
  assert_eq 'locked power-saver platform' low-power \
    "$(cat "${test_root}/sys/firmware/acpi/platform_profile")"
}

test_safety_state_blocks_unlocked_performance_drift() {
  setup_fixture
  write_state performance balanced-powersave 0 1
  for cpu in cpu0 cpu1; do
    printf '%s\n' performance \
      > "${test_root}/sys/devices/system/cpu/${cpu}/cpufreq/energy_performance_preference"
  done
  printf '%s\n' performance > "${test_root}/sys/firmware/acpi/platform_profile"

  run_helper rw reassert

  assert_eq 'safety state after performance drift' \
    "$(state_text performance balanced-powersave 0 1)" \
    "$(cat "${test_root}/var/lib/eppmode/state")"
  assert_eq 'safety EPP after performance drift' balance_power \
    "$(cat "${test_root}/sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference")"
  assert_eq 'safety platform after performance drift' balanced \
    "$(cat "${test_root}/sys/firmware/acpi/platform_profile")"
}

test_upower_failure_preserves_safety() {
  setup_fixture
  write_state performance balanced-powersave 0 1
  local before
  before="$(cat "${test_root}/var/lib/eppmode/state")"

  if run_helper rw battery-check >/dev/null 2>&1; then
    fail 'UPower failure unexpectedly succeeded'
  fi

  assert_eq 'state after UPower failure' "${before}" \
    "$(cat "${test_root}/var/lib/eppmode/state")"
}

test_upower_reply_engages_safety() {
  setup_fixture
  write_state performance performance 0 0

  MOCK_UPOWER=low run_helper rw battery-check

  assert_eq 'parsed UPower state' \
    "$(state_text performance balanced-powersave 0 1)" \
    "$(cat "${test_root}/var/lib/eppmode/state")"
}

test_battery_safety_transitions_after_hardware() {
  setup_fixture
  write_state performance performance 1 0

  FAKE_PERCENT=15 FAKE_STATE=discharging run_helper rw battery-check
  assert_eq 'low-battery state' \
    "$(state_text performance balanced-powersave 1 1)" \
    "$(cat "${test_root}/var/lib/eppmode/state")"
  assert_eq 'low-battery EPP' balance_power \
    "$(cat "${test_root}/sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference")"

  FAKE_PERCENT=15 FAKE_STATE=charging run_helper rw battery-check
  assert_eq 'charging state' \
    "$(state_text performance performance 1 0)" \
    "$(cat "${test_root}/var/lib/eppmode/state")"
  assert_eq 'restored EPP' performance \
    "$(cat "${test_root}/sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference")"
}

test_manual_power_saver_remains_active_below_threshold() {
  setup_fixture

  run_helper rw set power-saver
  FAKE_PERCENT=15 FAKE_STATE=discharging run_helper rw battery-check

  assert_eq 'manual power-saver state' \
    "$(state_text power-saver power-saver 0 0)" \
    "$(cat "${test_root}/var/lib/eppmode/state")"
  assert_eq 'manual power-saver EPP' power \
    "$(cat "${test_root}/sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference")"
  assert_eq 'manual power-saver platform_profile' low-power \
    "$(cat "${test_root}/sys/firmware/acpi/platform_profile")"
}

test_existing_safety_state_restores_selected_power_saver() {
  setup_fixture
  write_state power-saver balanced-powersave 1 1
  for cpu in cpu0 cpu1; do
    printf '%s\n' balance_power \
      > "${test_root}/sys/devices/system/cpu/${cpu}/cpufreq/energy_performance_preference"
  done

  FAKE_PERCENT=15 FAKE_STATE=discharging run_helper rw battery-check

  assert_eq 'migrated power-saver state' \
    "$(state_text power-saver power-saver 1 0)" \
    "$(cat "${test_root}/var/lib/eppmode/state")"
  assert_eq 'migrated power-saver EPP' power \
    "$(cat "${test_root}/sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference")"
}

test_failed_safety_write_preserves_state() {
  setup_fixture
  write_state performance performance 0 0
  local before
  before="$(cat "${test_root}/var/lib/eppmode/state")"

  if FAKE_PERCENT=15 FAKE_STATE=discharging \
    run_helper ro battery-check >/dev/null 2>&1; then
    fail 'read-only safety write unexpectedly succeeded'
  fi

  assert_eq 'state after failed safety write' "${before}" \
    "$(cat "${test_root}/var/lib/eppmode/state")"
}

tests=(
  test_successful_set_updates_hardware_and_state
  test_failed_write_preserves_state
  test_unsupported_epp_preserves_state
  test_missing_platform_profile_is_optional
  test_unstable_platform_profile_fails_without_state_update
  test_active_ppd_is_synchronized_to_base_profile
  test_ppd_sync_failure_preserves_hardware_and_state
  test_unlocked_platform_drift_adopts_balanced_performance
  test_unlocked_balanced_power_epp_remains_exact
  test_locked_platform_drift_restores_power_saver
  test_safety_state_blocks_unlocked_performance_drift
  test_upower_failure_preserves_safety
  test_upower_reply_engages_safety
  test_battery_safety_transitions_after_hardware
  test_manual_power_saver_remains_active_below_threshold
  test_existing_safety_state_restores_selected_power_saver
  test_failed_safety_write_preserves_state
)

for test_name in "${tests[@]}"; do
  "${test_name}"
  printf 'ok - %s\n' "${test_name}"
done

printf '%s tests passed\n' "${#tests[@]}"
