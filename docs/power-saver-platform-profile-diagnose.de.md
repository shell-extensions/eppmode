# Diagnose: Power-Saver-Wechsel scheitert am ThinkPad-Plattformprofil

**Status:** offen, nicht behoben
**Stand:** 27. Juli 2026

## Betroffenes System

- Lenovo ThinkPad X1 Yoga 4th (`20QGS00A00`)
- Ubuntu 24.04 mit Kernel `6.17.0-40-generic`
- BIOS `N2HET85W (1.68)`, EC `N2HHT43W`
- Provider: `thinkpad-acpi-profile`
- Providerpfad:
  `/sys/class/platform-profile/platform-profile-0/profile`

## Erwartetes Verhalten

Ein manueller Wechsel auf `power-saver` soll mit einem Klick alle Ebenen
konsistent setzen:

| Ebene | Zielwert |
|---|---|
| `power-profiles-daemon` | `power-saver` |
| CPU-EPP | `power` |
| `platform_profile` | `low-power` |
| EPPmode-State | `SELECTED=APPLIED=power-saver` |

Die manuelle Auswahl muss unabhängig vom Sperrzustand funktionieren. Die
Sperre soll nur spätere externe Abweichungen zurücksetzen.

## Beobachteter Fehler

Der Helper erreicht den Plattformprofil-Schritt erst, nachdem PPD und CPU-EPP
erfolgreich gesetzt wurden. Anschließend schreibt er `low-power` über den
koordinierten Sammelpfad
`/sys/firmware/acpi/platform_profile`. Der maßgebliche ThinkPad-Provider bleibt
jedoch auch nach drei Schreibimpulsen und acht Sekunden Prüfung auf
`balanced`.

Zwei reale Versuche nach Installation des Workarounds schlugen reproduzierbar
fehl:

```text
2026-07-27 05:50:32
platform_profile did not stabilize at low-power within the configured timeout
(thinkpad-acpi-profile=balanced)

2026-07-27 05:51:32
platform_profile did not stabilize at low-power within the configured timeout
(thinkpad-acpi-profile=balanced)
```

Der Helper beendet `set power-saver` deshalb mit einem Fehler und schreibt den
neuen State absichtlich nicht als erfolgreich. Bei `LOCK=1` führt der danach
ausgelöste Reassert den zuletzt bestätigten Zustand wieder vollständig aus.
Der sichtbare Endzustand ist daher:

```text
SELECTED=balanced-performance
APPLIED=balanced-performance
LOCK=1
SAFETY=0

power-profiles-daemon=balanced
platform_profile provider=balanced
platform_profile aggregate=balanced
CPU-EPP=balance_performance
```

Bei gelöster Sperre kann stattdessen kurz ein unvollständiger Hardwarezustand
sichtbar werden, bevor die Reconciliation den tatsächlich gelesenen Zustand
übernimmt. Die Sperre verursacht den Plattformfehler nicht; sie bestimmt nur,
wie EPPmode nach einem fehlgeschlagenen Wechsel reagiert.

## Eingegrenzte Ursache

Bestätigt ist die Fehlergrenze zwischen dem EPPmode-Helper und dem
ThinkPad-ACPI-/DYTC-Provider:

- PPD läuft mit blockiertem `platform_profile`-Treiber und ist nicht der
  zurücksetzende Akteur.
- CPU-EPP wird vor dem Plattformprofil erfolgreich geschrieben.
- Loadshed greift weder auf PPD, CPU-EPP noch `platform_profile` zu.
- Das Akku-Sicherheitsnetz war inaktiv (`SAFETY=0`); das Gerät hing am Netz und
  der Akku lag bei 98 Prozent.
- Der direkte Root-Helper-Aufruf scheitert genauso wie der Aufruf aus der
  GNOME-Erweiterung. Die UI ist daher nicht die Ursache.
- Der Provider bietet `low-power balanced performance` ausdrücklich als
  gültige Auswahl an, bestätigt `low-power` in diesen Versuchen aber nicht.

Ob die tiefere Ursache im Kernel-Treiber, in der verzögerten
DYTC-Ereignisverarbeitung oder in der Lenovo-Firmware liegt, ist noch nicht
abschließend bewiesen.

## Fehlgeschlagener Workaround

Der aktuelle Workaround vermeidet schnelle Wechsel zwischen Sammel- und
Providerpfad. Er schreibt bevorzugt über den Sammelpfad, prüft den Provider
alle 250 Millisekunden, verlangt drei aufeinanderfolgende Treffer und sendet
nach zwei und vier Sekunden je einen weiteren Schreibimpuls. Nach insgesamt
acht Sekunden schlägt er fehl.

Die zugehörigen simulierten Tests bestehen, der reale ThinkPad-Provider
konvergiert mit diesem ausschließlich koordinierten Schreibweg jedoch nicht.
Der Workaround ist deshalb auf diesem Gerät nicht ausreichend.

## Nächster technischer Ansatz

Der nächste Versuch soll gestuft arbeiten:

1. Einmal über den Sammelpfad schreiben und dessen Abschluss abwarten.
2. Bleibt der Provider abweichend, gezielt direkt in
   `platform-profile-0/profile` schreiben.
3. Direkte Wiederholungen mit ausreichendem Abstand statt schneller
   alternierender Zugriffe ausführen.
4. Erfolg erst nach mehreren stabilen Providerwerten melden.
5. Bei endgültigem Fehler State und Sperre unverändert lassen und den letzten
   Providerwert sowie den verwendeten Schreibweg protokollieren.

Als Abnahmekriterium muss der reale Wechsel
`balanced-performance` nach `power-saver` sowohl mit `LOCK=1` als auch mit
`LOCK=0` mit einem einzigen Helper-Aufruf gelingen. PPD, CPU-EPP,
Providerprofil und State müssen danach konsistent bleiben.
