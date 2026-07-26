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
  epp-modes-restore.service
  epp-modes-reassert.timer
  epp-modes-reassert.path
  epp-modes-reassert.service
  epp-modes-battery.timer
  epp-modes-battery.service
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
  /usr/local/bin/epp-modes-helper \
  /etc/sudoers.d/epp-modes \
  /etc/systemd/system/epp-modes-restore.service \
  /etc/systemd/system/epp-modes-reassert.service \
  /etc/systemd/system/epp-modes-reassert.path \
  /etc/systemd/system/epp-modes-reassert.timer \
  /etc/systemd/system/epp-modes-battery.service \
  /etc/systemd/system/epp-modes-battery.timer \
  /etc/systemd/system/multi-user.target.wants/epp-modes-restore.service \
  /etc/systemd/system/multi-user.target.wants/epp-modes-reassert.path \
  /etc/systemd/system/timers.target.wants/epp-modes-reassert.timer \
  /etc/systemd/system/timers.target.wants/epp-modes-battery.timer \
  /etc/udev/rules.d/99-epp-modes-power.rules

$SUDO rm -rf /var/lib/epp-modes

if command -v systemctl >/dev/null 2>&1; then
  $SUDO systemctl daemon-reload
fi
if command -v udevadm >/dev/null 2>&1; then
  $SUDO udevadm control --reload-rules
fi

echo "Removed EPP Power Modes root helper, units and state."
echo "The GNOME Shell extension itself is removed separately, e.g. via"
echo "gnome-extensions uninstall epp-modes@yurij.de"
