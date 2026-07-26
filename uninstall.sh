#!/usr/bin/env bash
set -euo pipefail

SUDO=""
if [[ "$(id -u)" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO=sudo
  else
    echo "This uninstaller must be run as root or with sudo available." >&2
    exit 1
  fi
fi

UNITS=(
  eppmode-restore.service
  eppmode-reassert.timer
  eppmode-reassert.path
  eppmode-reassert.service
  eppmode-battery.timer
  eppmode-battery.service
)

if command -v systemctl >/dev/null 2>&1; then
  # Disable one at a time: `systemctl disable --now A B C` fails atomically
  # (and silently) if any single unit is already missing.
  for unit in "${UNITS[@]}"; do
    $SUDO systemctl disable --now "${unit}" >/dev/null 2>&1 || true
  done
fi

# Explicit backstop for enable-symlinks under *.target.wants/ rather than
# trusting `disable` alone to have removed them.
$SUDO rm -f \
  /usr/local/bin/eppmode-helper \
  /etc/sudoers.d/eppmode \
  /etc/systemd/system/eppmode-restore.service \
  /etc/systemd/system/eppmode-reassert.service \
  /etc/systemd/system/eppmode-reassert.path \
  /etc/systemd/system/eppmode-reassert.timer \
  /etc/systemd/system/eppmode-battery.service \
  /etc/systemd/system/eppmode-battery.timer \
  /etc/systemd/system/multi-user.target.wants/eppmode-restore.service \
  /etc/systemd/system/multi-user.target.wants/eppmode-reassert.path \
  /etc/systemd/system/timers.target.wants/eppmode-reassert.timer \
  /etc/systemd/system/timers.target.wants/eppmode-battery.timer \
  /etc/udev/rules.d/99-eppmode-power.rules

$SUDO rm -rf /var/lib/eppmode

if command -v systemctl >/dev/null 2>&1; then
  $SUDO systemctl daemon-reload
fi
if command -v udevadm >/dev/null 2>&1; then
  $SUDO udevadm control --reload-rules
fi

echo "Removed EPP Power Modes root helper, units and state."
echo "The GNOME Shell extension itself is removed separately, e.g. via"
echo "gnome-extensions uninstall eppmode@yurij.de"
