# Diagnose: Power-Saver-Wechsel scheitert am ThinkPad-Plattformprofil

**Status:** Ursache weiterhin ungeklärt, Auswirkung softwareseitig abgefangen
(Teilerfolg-Semantik, siehe „Umsetzung“ unten)
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
- Der direkte Root-Helper-Aufruf scheitert genauso wie der Aufruf aus der
  GNOME-Erweiterung. Die UI ist daher nicht die Ursache.
- Der Provider bietet `low-power balanced performance` ausdrücklich als
  gültige Auswahl an, bestätigt `low-power` in diesen Versuchen aber nicht.

Ob die tiefere Ursache im Kernel-Treiber, in der verzögerten
DYTC-Ereignisverarbeitung oder in der Lenovo-Firmware liegt, ist nicht
abschließend bewiesen — siehe „Messung“ unten für die Hypothesen, die dabei
ausgeschlossen werden konnten.

**Widerlegt:** Ein früherer Verdacht war, dass Netzbetrieb (statt Akku) den
Wechsel blockiert. Das ist falsch — `low-power` wurde noch am selben Tag
erfolgreich am Netzteil (98 % Akku) angewendet, unter denselben Bedingungen,
unter denen zuvor wiederholt Fehlschläge auftraten. AC-Status korreliert mit
nichts.

## Fehlgeschlagener Workaround

Ein früherer Workaround vermied schnelle Wechsel zwischen Sammel- und
Providerpfad: bevorzugt über den Sammelpfad schreiben, den Provider alle 250
Millisekunden prüfen, drei aufeinanderfolgende Treffer verlangen, nach zwei
und vier Sekunden je einen weiteren Schreibimpuls senden, nach insgesamt acht
Sekunden aufgeben. Der reale ThinkPad-Provider konvergierte damit nicht — der
Workaround war auf diesem Gerät nicht ausreichend. Ein „gestufter direkter
Provider-Fallback“ (Sammelpfad, dann bei Abweichung gezielt direkt in
`platform-profile-0/profile` schreiben) wurde als nächster Schritt erwogen,
aber durch die Messung unten als von vornherein wirkungslos entlarvt: Es gibt
auf diesem Gerät nur einen Provider — Sammel- und Klassenpfad landen im
selben Kerneltreiber, ein alternativer Schreibweg existiert nicht.

## Messung

Ein eigenes Diagnosewerkzeug (`tools/eppmode-dytc-probe`, nicht von
`install.sh` installiert) hat `platform_profile`-Schreibvorgänge kontrolliert
wiederholt und dabei Systemzustand (AC, Akku, `dytc_lapmode`, Thermik, Last,
Abstand zum letzten Schreibvorgang) protokolliert. Drei Messrunden zu je 20
Versuchen (60 insgesamt, 27. Juli 2026):

1. **Isolierter Schreibvorgang** (nur `platform_profile`, kein EPP/PPD
   berührt): 20/20 angenommen, `converge_ms=0` — sofortige Konvergenz.
2. **Mit vorausgehendem EPP-/PPD-Schreibvorgang** (reproduziert die reale
   `apply_hardware()`-Abfolge, reihum `none`/`epp`/`ppd`/`both`): 20/20
   angenommen, unabhängig von der Variante.
3. **Mit korrekter Stabilitätsprüfung** (3 aufeinanderfolgende Treffer
   statt nur der erste Lesevorgang — die erste Runde hatte einen Messfehler,
   der ein kurzes Zurückspringen nicht erkannt hätte): weiterhin 20/20
   angenommen, `converge_ms=200` durchgängig.

**Ergebnis:** Weder isoliertes Schreiben, noch EPP-/PPD-Nähe, noch kurzes
Flackern erklären die realen Fehlschläge — in 60 kontrollierten Versuchen trat
keiner auf. Die real beobachteten Fehlschläge traten ausschließlich bei
mehrfachen **manuellen** Aufrufen im Sekunden- bis Minutenabstand auf,
teils überlappend mit dem alle 10 Sekunden laufenden `reassert`. Der Probe
serialisiert genau das bewusst weg (Units gestoppt, 30 s Cooldown zwischen
Versuchen) — ob nebenläufiger Zugriff die fehlende Zutat ist, bleibt darum
offen. Nach drei Runden ohne eine einzige Reproduktion wurde die Messung
eingestellt (sinkender Grenzertrag) zugunsten der Umsetzung unten, die
unabhängig von der Ursache wirkt.

## Umsetzung

Statt die Ursache weiter zu jagen, behandelt `tools/eppmode-helper` ein nicht
bestätigtes `platform_profile` jetzt als **Teilerfolg** statt als
Gesamtfehler: `apply_platform_profile()` gibt `2` zurück, wenn EPP und
`power-profiles-daemon` korrekt gesetzt sind, aber der Provider den
Zielwert nicht innerhalb des (deutlich verkürzten) Poll-Budgets bestätigt.
Der Zustand landet in einem neuen State-Feld `PLATFORM_PENDING`; der Modus
gilt als aktiv (die Kachel zeigt ihn korrekt an, da sie ausschließlich EPP
liest), `LOCK` bleibt unangetastet, und der ohnehin alle 10 Sekunden laufende
`reassert` zieht das offene Plattformprofil im Hintergrund nach — gebremst
durch eine neue Cooldown-Datei (`/var/lib/eppmode/.platform-write`,
Standard 30 s), damit wiederholte Reassert-Läufe DYTC nicht mit
Schreibversuchen bombardieren. Menü zeigt „Plattformprofil ausstehend“, wenn
`PLATFORM_PENDING` gesetzt ist.

Damit ist `power-saver` unabhängig vom ungeklärten DYTC-Verhalten sofort
nutzbar: EPP greift immer, das Plattformprofil zieht nach, sobald DYTC es
zulässt.
