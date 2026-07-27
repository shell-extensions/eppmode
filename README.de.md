# EPP Power Modes

[English](README.md) | [**Deutsch**](README.de.md) | [Español](README.es.md)

Eine Schnelleinstellungen-Erweiterung für GNOME Shell (46+) mit vier festen
Zuständen für die CPU-Energie-Leistungs-Voreinstellung (EPP):

| Modus                  | EPP                   | `platform_profile` |
|------------------------|-----------------------|--------------------|
| Energie sparen         | `power`               | `low-power`        |
| Ausgeglichen-Sparsam   | `balance_power`       | `balanced`         |
| Ausgeglichen-Leistung  | `balance_performance` | `balanced`         |
| Leistung               | `performance`         | `performance`      |

Dazu kommen ein **Sperren**-Schalter, der automatische Abweichungen durch
Firmware oder ACPI-Hotkeys verhindert, ohne die manuelle Auswahl
einzuschränken, und ein **Akku-Sicherheitsnetz**. Dieses erzwingt beim Entladen
unter 20 % mindestens den Modus `Ausgeglichen-Sparsam`, unabhängig vom
Sperrzustand. Ein manuell gewählter Modus `Energie sparen` bleibt aktiv.
Beim Umschalten der Sperre bleibt das Menü geöffnet und die Regel wird sofort
gespeichert. Schlägt der nächste Durchsetzungsversuch fehl, wird die Sperre
wieder deaktiviert, statt einen Schutz anzuzeigen, den die Hardware nicht
einhalten konnte.

Nachfolger von
[`power-saver-epp-fix`](https://github.com/shell-extensions/power-saver-epp-fix);
die vollständige Designbegründung steht in [PLAN.md](PLAN.md).

![Schnelleinstellungsmenü von EPP Power Modes](image/eppmode-quick-settings.png)

## Hardwarestatus

Die Kachel liest den EPP-Wert jeder verfügbaren CPU direkt aus sysfs. Sie
aktualisiert sich nach eigenen Änderungen, beim Öffnen des Menüs und alle fünf
Sekunden. Dadurch werden externe EPP-Änderungen auch bei deaktivierter Sperre
sichtbar. Die vier exakten Werte werden direkt auf die vier Modi aus der
Tabelle abgebildet. Abweichende CPU-Werte erscheinen als **Uneinheitlich**,
nicht lesbare oder nicht unterstützte EPP-Werte als **Unbekannt**.
Wenn `platform_profile` vorhanden ist, prüft der Helfer, dass EPP und
Plattformprofil konsistent bleiben. Bei aktiver Sperre wird eine Abweichung
zurückgesetzt. Bei gelöster Sperre wird eine externe Plattformänderung
übernommen: `balanced` wird zu `Ausgeglichen-Leistung`, sofern die CPUs nicht
bereits `balance_power` melden.
Auf neueren Kerneln sind die providerspezifischen Schnittstellen unter
`/sys/class/platform-profile/` für Lesen und Prüfung maßgeblich. Zum Schreiben
bevorzugt der Helfer den alten Sammelpfad
`/sys/firmware/acpi/platform_profile` als vom Kernel koordinierten Weg und
greift nur dann direkt auf die Providerdateien zurück, wenn dieser Sammelpfad
nicht verfügbar ist oder den Schreibzugriff ablehnt. Da ThinkPad-DYTC-Firmware
ein Profil verzögert bestätigen kann, wartet der Helfer bis zu acht Sekunden
und verlangt drei aufeinanderfolgende passende Providerwerte. Statt schnell
zwischen beiden Schnittstellen zu wechseln, sendet er höchstens zwei weitere
Schreibimpulse mit Abstand.

Der Installer lässt `power-profiles-daemon` aktiv, startet ihn aber mit
blockiertem `platform_profile`-Treiber neu. Dazu verwendet er den bereits in
`power-saver-epp-fix` bewährten Guard. Der Helfer wählt zunächst PPDs passendes
grobes Profil, wartet dessen CPU-Schreibvorgang ab und setzt und prüft danach
den exakten EPP- und Plattformzustand aus der Tabelle. Die Deinstallation
entfernt den Guard und startet PPD wieder normal.

## Diagnoseberichte

- [Offener Fehler: Power-Saver-Wechsel scheitert am
  ThinkPad-Plattformprofil](docs/power-saver-platform-profile-diagnose.de.md)

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
