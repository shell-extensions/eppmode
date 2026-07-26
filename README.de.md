# EPP Power Modes

[English](README.md) | [**Deutsch**](README.de.md) | [Español](README.es.md)

Eine Schnelleinstellungen-Erweiterung für GNOME Shell (46+) mit vier festen
Zuständen für die CPU-Energie-Leistungs-Voreinstellung (EPP), die
`power-profiles-daemon` vollständig umgeht:

| Modus                  | EPP                   | `platform_profile` |
|------------------------|-----------------------|--------------------|
| Energie sparen         | `power`               | `low-power`        |
| Ausgeglichen-Sparsam   | `balance_power`       | `balanced`         |
| Ausgeglichen-Leistung  | `balance_performance` | `balanced`         |
| Leistung               | `performance`         | `performance`      |

Dazu kommen ein **Sperren**-Schalter, der automatische Abweichungen durch
Firmware oder ACPI-Hotkeys verhindert, ohne die manuelle Auswahl
einzuschränken, und ein **Akku-Sicherheitsnetz**. Dieses erzwingt beim Entladen
unter 20 % den Modus `Ausgeglichen-Sparsam`, unabhängig vom Sperrzustand.

Nachfolger von
[`power-saver-epp-fix`](https://github.com/shell-extensions/power-saver-epp-fix);
die vollständige Designbegründung steht in [PLAN.md](PLAN.md).

![Schnelleinstellungsmenü von EPP Power Modes](image/eppmode-quick-settings.png)

## Installation

```sh
bash install.sh
```

Installiert einen Root-Helfer unter `/usr/local/bin/eppmode-helper`, eine auf
genau dieses Programm beschränkte passwortlose sudoers-Regel
(`/etc/sudoers.d/eppmode`) sowie systemd-Units für die Wiederherstellung beim
Start, die erneute Durchsetzung des Sperrzustands und die regelmäßige Prüfung
des Akku-Sicherheitsnetzes. `sudo` wird benötigt.

## Deinstallation

```sh
bash uninstall.sh
```

Entfernt den Helfer, die sudoers-Regel, die systemd-Units, die udev-Regel und
das Zustandsverzeichnis. Die GNOME-Shell-Erweiterung selbst muss separat
entfernt werden, zum Beispiel mit:

```sh
gnome-extensions uninstall eppmode@yurij.de
```

## Übersetzungen

Englisch (Quellsprache), Deutsch und Spanisch. Nach Änderungen an
`extension.js` oder einer `.po`-Datei können `po/eppmode.pot` und die
kompilierten `.mo`-Dateien so neu erzeugt werden:

```sh
tools/build-locale.sh
```

## Lizenz

GPL-3.0-or-later, siehe `LICENSE`.
