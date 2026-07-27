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
case "$1" in
  get)
    if [ -r /var/lib/eppmode/ppd-profile ]; then
      cat /var/lib/eppmode/ppd-profile
    else
      printf '%s\n' "${MOCK_PPD_CURRENT:-unknown}"
    fi
    ;;
  set)
    [ "${MOCK_PPD_FAIL:-0}" != "1" ] || exit 1
    printf '%s\n' "$2" > /var/lib/eppmode/ppd-profile
    : > /var/lib/eppmode/ppd-set-called
    ;;
  *)
    exit 2
    ;;
esac
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

setup_class_profile() {
  local index="${1:-0}"
  local profile="${2:-balanced}"
  local class_dir="${test_root}/sys/class/platform-profile/platform-profile-${index}"
  mkdir -p "${class_dir}"
  printf '%s\n' 'low-power balanced performance' > "${class_dir}/choices"
  printf '%s\n' "${profile}" > "${class_dir}/profile"
  printf 'mock-platform-profile-%s\n' "${index}" > "${class_dir}/name"
}

run_helper() {
  local sys_mode="$1"
  shift
  local bind_option=--bind
  local -a extra_bind_args=()
  if [[ "${sys_mode}" == ro ]]; then
    bind_option=--ro-bind
  elif [[ "${sys_mode}" == provider-ro ]]; then
    extra_bind_args=(
      --ro-bind
      "${test_root}/sys/class/platform-profile/platform-profile-0/profile"
      /sys/class/platform-profile/platform-profile-0/profile
    )
  fi

  bwrap \
    --die-with-parent \
    --unshare-user \
    --uid 0 \
    --gid 0 \
    --ro-bind / / \
    --dev /dev \
    "${bind_option}" "${test_root}/sys" /sys \
    "${extra_bind_args[@]}" \
    --bind "${test_root}/var" /var \
    --setenv PATH "${test_root}/bin:/usr/bin:/bin" \
    --setenv EPPMODE_PLATFORM_POLL_DELAY "${EPPMODE_PLATFORM_POLL_DELAY:-0}" \
    --setenv EPPMODE_PLATFORM_MAX_POLLS "${EPPMODE_PLATFORM_MAX_POLLS:-32}" \
    --setenv EPPMODE_PLATFORM_STABLE_READS "${EPPMODE_PLATFORM_STABLE_READS:-3}" \
    --setenv EPPMODE_PLATFORM_RETRY_EVERY "${EPPMODE_PLATFORM_RETRY_EVERY:-8}" \
    --setenv EPPMODE_PLATFORM_MAX_WRITES "${EPPMODE_PLATFORM_MAX_WRITES:-3}" \
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

test_provider_profile_is_authoritative_over_legacy_interface() {
  setup_fixture
  setup_class_profile 0 low-power
  write_state power-saver power-saver 1 0
  printf '%s\n' power > "${test_root}/sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference"
  printf '%s\n' power > "${test_root}/sys/devices/system/cpu/cpu1/cpufreq/energy_performance_preference"

  run_helper ro reassert

  assert_eq 'provider platform_profile' low-power \
    "$(cat "${test_root}/sys/class/platform-profile/platform-profile-0/profile")"
  assert_eq 'unchanged legacy platform_profile' balanced \
    "$(cat "${test_root}/sys/firmware/acpi/platform_profile")"
  assert_eq 'provider-backed state' \
    "$(state_text power-saver power-saver 1 0)" \
    "$(cat "${test_root}/var/lib/eppmode/state")"
}

test_legacy_coordinator_sets_provider_profile() {
  setup_fixture
  setup_class_profile 0 balanced
  rm "${test_root}/sys/class/platform-profile/platform-profile-0/profile"
  ln -s ../../../firmware/acpi/platform_profile \
    "${test_root}/sys/class/platform-profile/platform-profile-0/profile"

  run_helper rw set power-saver

  assert_eq 'coordinated provider platform_profile' low-power \
    "$(cat "${test_root}/sys/class/platform-profile/platform-profile-0/profile")"
  assert_eq 'coordinated legacy platform_profile' low-power \
    "$(cat "${test_root}/sys/firmware/acpi/platform_profile")"
  assert_eq 'coordinated state' \
    "$(state_text power-saver power-saver 0 0)" \
    "$(cat "${test_root}/var/lib/eppmode/state")"
}

test_delayed_provider_convergence_succeeds_with_one_set() {
  local lock watcher
  for lock in 0 1; do
    setup_fixture
    setup_class_profile 0 balanced
    write_state balanced-performance balanced-performance "${lock}" 0

    (
      for _ in {1..200}; do
        if [[ "$(<"${test_root}/sys/firmware/acpi/platform_profile")" == low-power ]]; then
          sleep 0.15
          printf '%s\n' low-power \
            > "${test_root}/sys/class/platform-profile/platform-profile-0/profile"
          exit 0
        fi
        sleep 0.01
      done
      exit 1
    ) &
    watcher=$!

    EPPMODE_PLATFORM_POLL_DELAY=0.05 \
      EPPMODE_PLATFORM_MAX_POLLS=40 \
      run_helper provider-ro set power-saver
    wait "${watcher}" || fail 'delayed provider watcher did not converge'

    assert_eq "delayed provider profile with lock=${lock}" low-power \
      "$(<"${test_root}/sys/class/platform-profile/platform-profile-0/profile")"
    assert_eq "delayed state with lock=${lock}" \
      "$(state_text power-saver power-saver "${lock}" 0)" \
      "$(<"${test_root}/var/lib/eppmode/state")"
  done
}

test_transient_provider_match_does_not_succeed() {
  setup_fixture
  setup_class_profile 0 balanced
  local before watcher
  before="$(<"${test_root}/var/lib/eppmode/state")"

  (
    for _ in {1..200}; do
      if [[ "$(<"${test_root}/sys/firmware/acpi/platform_profile")" == low-power ]]; then
        sleep 0.07
        printf '%s\n' low-power \
          > "${test_root}/sys/class/platform-profile/platform-profile-0/profile"
        sleep 0.06
        printf '%s\n' balanced \
          > "${test_root}/sys/class/platform-profile/platform-profile-0/profile"
        exit 0
      fi
      sleep 0.01
    done
    exit 1
  ) &
  watcher=$!

  if EPPMODE_PLATFORM_POLL_DELAY=0.05 \
    EPPMODE_PLATFORM_MAX_POLLS=8 \
    EPPMODE_PLATFORM_RETRY_EVERY=4 \
    run_helper provider-ro set power-saver >/dev/null 2>&1; then
    fail 'transient provider match unexpectedly succeeded'
  fi
  wait "${watcher}" || fail 'transient provider watcher did not run'

  assert_eq 'state after transient provider match' "${before}" \
    "$(<"${test_root}/var/lib/eppmode/state")"
}

test_permanent_provider_mismatch_times_out() {
  setup_fixture
  setup_class_profile 0 balanced
  local before
  before="$(<"${test_root}/var/lib/eppmode/state")"

  if EPPMODE_PLATFORM_MAX_POLLS=6 \
    EPPMODE_PLATFORM_RETRY_EVERY=2 \
    run_helper provider-ro set power-saver >/dev/null 2>&1; then
    fail 'permanent provider mismatch unexpectedly succeeded'
  fi

  assert_eq 'state after permanent provider mismatch' "${before}" \
    "$(<"${test_root}/var/lib/eppmode/state")"
}

test_direct_provider_fallback_without_aggregate() {
  setup_fixture
  setup_class_profile 0 balanced
  rm -rf "${test_root}/sys/firmware/acpi"

  run_helper rw set power-saver

  assert_eq 'direct provider fallback profile' low-power \
    "$(<"${test_root}/sys/class/platform-profile/platform-profile-0/profile")"
  assert_eq 'direct provider fallback state' \
    "$(state_text power-saver power-saver 0 0)" \
    "$(<"${test_root}/var/lib/eppmode/state")"
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

test_matching_ppd_profile_is_not_written_again() {
  setup_fixture
  printf '%s\n' power > "${test_root}/sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference"
  printf '%s\n' power > "${test_root}/sys/devices/system/cpu/cpu1/cpufreq/energy_performance_preference"
  printf '%s\n' low-power > "${test_root}/sys/firmware/acpi/platform_profile"
  printf '%s\n' power-saver > "${test_root}/var/lib/eppmode/ppd-profile"

  EPPMODE_PPD_DELAY=0 MOCK_PPD_ACTIVE=1 run_helper rw set power-saver

  if [[ -e "${test_root}/var/lib/eppmode/ppd-set-called" ]]; then
    fail 'matching PPD profile was written again'
  fi
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

test_lock_only_updates_persisted_state() {
  setup_fixture

  run_helper ro lock

  assert_eq 'state-only lock' \
    "$(state_text balanced-performance balanced-performance 1 0)" \
    "$(cat "${test_root}/var/lib/eppmode/state")"
}

test_matching_locked_state_requires_no_hardware_write() {
  setup_fixture
  write_state power-saver power-saver 1 0
  printf '%s\n' power > "${test_root}/sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference"
  printf '%s\n' power > "${test_root}/sys/devices/system/cpu/cpu1/cpufreq/energy_performance_preference"
  printf '%s\n' low-power > "${test_root}/sys/firmware/acpi/platform_profile"

  run_helper ro reassert

  assert_eq 'unchanged matching lock state' \
    "$(state_text power-saver power-saver 1 0)" \
    "$(cat "${test_root}/var/lib/eppmode/state")"
}

test_failed_locked_reassert_disables_lock_and_preserves_safety() {
  setup_fixture
  write_state performance balanced-powersave 1 1
  rm "${test_root}/sys/firmware/acpi/platform_profile"
  ln -s /dev/null "${test_root}/sys/firmware/acpi/platform_profile"

  if run_helper rw reassert >/dev/null 2>&1; then
    fail 'unstable locked reassert unexpectedly succeeded'
  fi

  assert_eq 'state after failed locked reassert' \
    "$(state_text performance balanced-powersave 0 1)" \
    "$(cat "${test_root}/var/lib/eppmode/state")"
}

test_failed_safety_only_reassert_is_reported() {
  setup_fixture
  write_state performance balanced-powersave 0 1
  rm "${test_root}/sys/firmware/acpi/platform_profile"
  ln -s /dev/null "${test_root}/sys/firmware/acpi/platform_profile"
  local output

  if output="$(run_helper rw reassert 2>&1)"; then
    fail 'unstable safety-only reassert unexpectedly succeeded'
  fi

  if [[ "${output}" != *"Battery safety power mode could not be enforced"* ]]; then
    fail 'safety-only reassert did not report its enforcement failure'
  fi
  assert_eq 'state after failed safety-only reassert' \
    "$(state_text performance balanced-powersave 0 1)" \
    "$(cat "${test_root}/var/lib/eppmode/state")"
}

test_unlocked_platform_read_failure_is_reported() {
  setup_fixture
  setup_class_profile 0 balanced
  rm "${test_root}/sys/class/platform-profile/platform-profile-0/profile"
  mkdir "${test_root}/sys/class/platform-profile/platform-profile-0/profile"
  local output

  if output="$(run_helper ro reassert 2>&1)"; then
    fail 'unreadable unlocked platform profile unexpectedly succeeded'
  fi

  if [[ "${output}" != *"Could not read platform_profile while reconciling unlocked hardware state"* ]]; then
    fail 'unlocked platform read failure was not reported'
  fi
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
  test_provider_profile_is_authoritative_over_legacy_interface
  test_legacy_coordinator_sets_provider_profile
  test_delayed_provider_convergence_succeeds_with_one_set
  test_transient_provider_match_does_not_succeed
  test_permanent_provider_mismatch_times_out
  test_direct_provider_fallback_without_aggregate
  test_active_ppd_is_synchronized_to_base_profile
  test_matching_ppd_profile_is_not_written_again
  test_ppd_sync_failure_preserves_hardware_and_state
  test_unlocked_platform_drift_adopts_balanced_performance
  test_unlocked_balanced_power_epp_remains_exact
  test_locked_platform_drift_restores_power_saver
  test_lock_only_updates_persisted_state
  test_matching_locked_state_requires_no_hardware_write
  test_failed_locked_reassert_disables_lock_and_preserves_safety
  test_failed_safety_only_reassert_is_reported
  test_unlocked_platform_read_failure_is_reported
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
