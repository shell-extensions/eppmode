#!/usr/bin/env bash
set -euo pipefail

UUID="epp-modes@shell-extensions.github.io"
HELPER_NAME="epp-modes-helper"
HELPER_INSTALL_PATH="/usr/local/bin/${HELPER_NAME}"
SUDOERS_FILE="/etc/sudoers.d/epp-modes"
STATE_DIR="/var/lib/epp-modes"

UNITS=(
  epp-modes-restore.service
  epp-modes-reassert.service
  epp-modes-reassert.path
  epp-modes-reassert.timer
  epp-modes-battery.service
  epp-modes-battery.timer
)
UDEV_RULE="99-epp-modes-power.rules"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

candidates=(
  "${script_dir}/tools"
  "${HOME}/.local/share/gnome-shell/extensions/${UUID}/tools"
  "/usr/share/gnome-shell/extensions/${UUID}/tools"
)

tools_dir=""
for path in "${candidates[@]}"; do
  if [[ -f "${path}/${HELPER_NAME}" ]]; then
    tools_dir="${path}"
    break
  fi
done

if [[ -z "${tools_dir}" ]]; then
  echo "tools/ directory not found. Looked in:" >&2
  printf '  %s\n' "${candidates[@]}" >&2
  exit 1
fi

if ! command -v sudo >/dev/null 2>&1; then
  echo "sudo not found. Install sudo or run this as root." >&2
  exit 1
fi

if [[ ! -d /sys/devices/system/cpu/cpu0/cpufreq ]]; then
  echo "No CPU cpufreq sysfs interface found. Nothing was installed." >&2
  exit 1
fi

if [[ ! -r /sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference ]]; then
  echo "CPU EPP sysfs interface not found. This tool is intended for systems exposing energy_performance_preference." >&2
  exit 1
fi

target_user="${SUDO_USER:-${USER:-$(id -un)}}"
if [[ -z "${target_user}" ]]; then
  echo "Could not determine target user." >&2
  exit 1
fi

if [[ ! "${target_user}" =~ ^[a-z_][a-z0-9._-]*$ ]]; then
  echo "Refusing to write sudoers for unexpected username: ${target_user}" >&2
  exit 1
fi

echo "Installing helper from ${tools_dir}/${HELPER_NAME} to ${HELPER_INSTALL_PATH}"
sudo install -o root -g root -m 0755 "${tools_dir}/${HELPER_NAME}" "${HELPER_INSTALL_PATH}"

sudo install -d -o root -g root -m 0755 "${STATE_DIR}"

sudo tee "${SUDOERS_FILE}" >/dev/null <<EOF
${target_user} ALL=(root) NOPASSWD: ${HELPER_INSTALL_PATH}
EOF
sudo chmod 0440 "${SUDOERS_FILE}"
sudo visudo -c -f "${SUDOERS_FILE}" >/dev/null

if command -v systemctl >/dev/null 2>&1; then
  for unit in "${UNITS[@]}"; do
    echo "Installing ${unit}"
    sudo install -o root -g root -m 0644 "${tools_dir}/${unit}" "/etc/systemd/system/${unit}"
  done

  if [[ -r /sys/firmware/acpi/platform_profile && -r /sys/firmware/acpi/platform_profile_choices ]]; then
    sudo install -o root -g root -m 0644 "${tools_dir}/${UDEV_RULE}" "/etc/udev/rules.d/${UDEV_RULE}"
    if command -v udevadm >/dev/null 2>&1; then
      sudo udevadm control --reload-rules
    fi
  else
    echo "No ACPI platform_profile sysfs interface; skipping udev rule (EPP-only reassertion still applies)." >&2
  fi

  sudo systemctl daemon-reload
  sudo systemctl enable --now epp-modes-restore.service
  sudo systemctl enable --now epp-modes-reassert.path epp-modes-reassert.timer
  sudo systemctl enable --now epp-modes-battery.timer
else
  echo "systemctl not found; skipping systemd unit install." >&2
fi

echo "Done."
echo "Restart GNOME Shell or disable/enable the extension."
