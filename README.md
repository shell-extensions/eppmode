# EPP Power Modes

A GNOME Shell (46+) Quick Settings extension for four fixed CPU
energy-performance-preference (EPP) states, bypassing
`power-profiles-daemon` entirely:

| Mode                    | EPP                    | `platform_profile` |
|--------------------------|-------------------------|---------------------|
| Power Saver              | `power`                 | `low-power`          |
| Balanced-Saver            | `balance_power`         | `balanced`            |
| Balanced-Performance      | `balance_performance`   | `balanced`            |
| Performance               | `performance`           | `performance`         |

Plus a **Lock** switch that blocks automatic (firmware/ACPI-hotkey) drift
without affecting manual selection, and a **battery safety net** that
forces `Balanced-Saver` below 20% while discharging, unaffected by Lock.

Successor to
[`power-saver-epp-fix`](https://github.com/shell-extensions/power-saver-epp-fix);
see `PLAN.md` for the full design rationale.

## Install

```sh
bash install.sh
```

Installs a root helper to `/usr/local/bin/eppmode-helper`, a
passwordless sudoers rule scoped to that single binary
(`/etc/sudoers.d/eppmode`), and systemd units for boot restore, lock
drift-reassertion and the battery safety-net poll. Requires `sudo`.

## Uninstall

```sh
bash uninstall.sh
```

Removes the helper, sudoers rule, systemd units, udev rule and state
directory. Remove the GNOME Shell extension itself separately, e.g.:

```sh
gnome-extensions uninstall eppmode@yurij.de
```

## Translations

English (source), German and Spanish. To regenerate `po/eppmode.pot`
and rebuild the compiled `.mo` files after editing `extension.js` or a
`.po` file:

```sh
tools/build-locale.sh
```

## License

GPL-3.0-or-later, see `LICENSE`.
