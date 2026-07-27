# EPP Power Modes: GNOME-Shell-Extension als Nachfolger von power-saver-epp-fix

Status: Implementiert (extension.js, Helper, systemd/udev, install.sh/uninstall.sh, po/locale), noch nicht auf dem System installiert. Dieses Dokument beschreibt weiterhin den Designstand, an dem sich die Implementierung orientiert.

## Kontext

`power-saver-epp-fix` (`/home/yurij/web/git/power-saver-epp-fix`) hält GNOMEs `power-saver`-Profil aktiv, überschreibt aber die von `power-profiles-daemon` gesetzte CPU-EPP-Vorgabe. In einer ausführlichen Debugging-Sitzung wurde außerdem ein Root-Cause-Bug in `power-profiles-daemon` selbst gejagt (Guard-Reste, Reconcile-Fehler, `disable --now`-Batching-Bug) — die ganze Klasse an Problemen entsteht daraus, dass zwei Werkzeuge (GNOME/`power-profiles-daemon` und unser Override) um dieselben drei Profile konkurrieren.

Statt GNOMEs fest auf drei Profile begrenztem Schalter (`power-saver`/`balanced`/`performance` — verifiziert hart im `power-profiles-daemon`-Protokoll kodiert, Version 0.21) soll ein **eigener** Schalter mit **vier** Zuständen entstehen, die direkt Intels vier EPP-Stufen abbilden, plus ein **Lock**-Schalter, der automatische Wechsel verhindert. Da GNOMEs eigener Mechanismus dafür architektonisch zu eng ist, entsteht das als **komplett neues Repo mit einer echten GNOME-Shell-Extension** (nicht mehr nur ein Skript), vorgesehen für `github.com/shell-extensions`. `power-saver-epp-fix` bleibt unverändert bestehen; dieses neue Projekt ersetzt es funktional, ohne es zu modifizieren.

Alle Kernentscheidungen wurden mit dem Nutzer über mehrere Rückfragen abgestimmt und sind hier nicht mehr offen — der Plan beschreibt den einen gewählten Ansatz, nicht Alternativen.

## Referenz-Implementierungen (im selben Workspace, bereits ausgewertet)

- **`/home/yurij/web/git/thinkpad-red-led@juanmagd.dev/`** — die engste Vorlage: löst exakt dasselbe Problem (unprivilegierte GJS-Extension muss privilegierten Hardware-Zustand steuern) mit `QuickSettings.QuickMenuToggle` + `SystemIndicator`, Root-Brücke via `sudo -n` + NOPASSWD-Sudoers + Helper-Skript, root-owned State-File, systemd-Restore-Unit.
- **`/home/yurij/web/git/power-saver-epp-fix/src/ppd-epp-override`** — bereits bewährte Sysfs-Schreib-Loops für EPP und `platform_profile` (inkl. Verfügbarkeitsprüfung), direkt wiederverwendbar für die neue Helper-Logik.
- **`/home/yurij/web/git/power-saver-epp-fix/systemd/*.path,*.timer`** und **`uninstall.sh`** — bewährtes Drift-Watch-Muster, sowie zwei gefundene und gefixte Bugs, die hier von Anfang an vermieden werden.
- **`/home/yurij/web/git/gold-silver-price@arononak.github.io/`** — `PopupMenu.PopupSwitchMenuItem`-Muster für den Lock-Schalter.

## Bestätigte Design-Entscheidungen

1. **Neues Repo**, GNOME-Shell-46-Extension (GJS), Ubuntu 24.04 / Intel `intel_pstate`/HWP — dieselbe Hardware-Basis wie `power-saver-epp-fix`.
2. **Vier feste Zustände**, unabhängig von Netz/Akku (kein Auto-Wechsel je Stromquelle mehr wie im alten Projekt — der Nutzer wählt jetzt bewusst selbst):
   - `power-saver` → EPP `power`, platform_profile `low-power`
   - `balanced-powersave` → EPP `balance_power`, platform_profile `low-power`
   - `balanced-performance` → EPP `balance_performance`, platform_profile `balanced`
   - `performance` → EPP `performance`, platform_profile `performance`

   `platform_profile` hat nur drei Stufen (`low-power`/`balanced`/`performance`)
   gegenüber den vier EPP-Stufen; `balanced-powersave` teilt sich die
   `low-power`-Stufe mit `power-saver` statt mit `balanced-performance`, weil
   auf ThinkPad-DYTC-Hardware `platform_profile` — nicht EPP — den
   Lüfter/die Thermik steuert (live beobachtet: Anwender wechselte von
   `performance` auf `balanced-powersave`, Lüfter blieb unverändert, weil
   `platform_profile` in beiden Fällen `balanced` gewesen wäre). EPP bleibt
   innerhalb der `low-power`-Stufe der feinere Regler zwischen `power-saver`
   und `balanced-powersave`.

   Beschriftungen in drei Sprachen (Englisch als Quellsprache/msgid, Deutsch, Spanisch — siehe Abschnitt „Mehrsprachigkeit"), je Zustand in zwei Formen, weil Menü und Kachel unterschiedlich viel Platz haben:

   **Menü-Label (volle Form):**

   | ID | English (msgid) | Deutsch | Español |
   |---|---|---|---|
   | `power-saver` | Power Saver | Energie sparen | Ahorro de energía |
   | `balanced-powersave` | Balanced-Saver | Ausgeglichen-Sparsam | Equilibrado-Ahorro |
   | `balanced-performance` | Balanced-Performance | Ausgeglichen-Leistung | Equilibrado-Rendimiento |
   | `performance` | Performance | Leistung | Rendimiento |

   **Kachel-Untertitel (Kurzform, ≤ 14 Zeichen — siehe Begründung unten):**

   | ID | English | Deutsch | Español |
   |---|---|---|---|
   | `power-saver` | Saver | Sparen | Ahorro |
   | `balanced-powersave` | Balanced − | Ausgeglichen − | Equilibrado − |
   | `balanced-performance` | Balanced + | Ausgeglichen + | Equilibrado + |
   | `performance` | Performance | Leistung | Rendimiento |

   Kachel-Titel: `Power` / „Energie" / „Energía" (je 5–7 Zeichen).

   „Energie sparen", „Ausgeglichen", „Leistung", „Ahorro de energía", „Equilibrado" und „Rendimiento" sind wortgleich GNOMEs offizielle Übersetzungen (verifiziert aus `/usr/share/locale-langpack/{de,es}/LC_MESSAGES/gnome-shell.mo`) — die beiden Zwischenstufen fügen sich dadurch als natürliche Verfeinerung derselben Skala ein statt wie Fremdkörper zu wirken.

   **Warum zwei Formen je Modus:** „Energieoptionen" (15 Zeichen) wird in der Quick-Settings-Kachel nachweislich abgeschnitten — die nutzbare Breite liegt bei etwa 14 Zeichen. „Ausgeglichen-Leistung" (21) oder „Ahorro de energía" (17) würden als Untertitel ebenso abgeschnitten. Die Kurzformen bleiben in allen drei Sprachen bei ≤ 14 Zeichen; die volle Bezeichnung steht im Dropdown, wo die Breite ausreicht.
3. **UI**: ein Quick-Settings-Toggle mit Dropdown/Submenü — 4 Radio-Zustände + Trennlinie + „Lock"-Switch-Eintrag + Trennlinie + Link zu den Energieeinstellungen (siehe UI-Abschnitt unten).
4. **Lock**: blockiert nur *automatische* Änderungen (Firmware-/ACPI-Hotkey-Drift). Manuelle Auswahl über unsere Extension funktioniert **immer sofort**, auch bei aktivem Lock.
5. **Akku-Sicherheitsnetz** (Ausnahme, die sogar Lock übersteuert): Kein selbstgebautes Lastmonitoring nötig — verifiziert, dass Intel-CPUs im Leerlauf unabhängig von EPP über C-States (C1–C10 bestätigt) selbst herunterregeln. Stattdessen wird **UPowers Akkustand direkt** gelesen (`org.freedesktop.UPower`, `DisplayDevice`) — dieselbe Kennzahl, auf der auch GNOMEs eigenes `power-saver-profile-on-low-battery`-Feature basiert. Unter 20% *und* im Akkubetrieb wird unabhängig von Lock mindestens `balanced-powersave` erzwungen. Ein manuell gewählter, noch sparsamerer `power-saver` bleibt aktiv und wird vom Sicherheitsnetz nicht abgeschwächt. Ab 25% oder bei Netzbetrieb wird automatisch der zuletzt gewählte Zustand wiederhergestellt (Hysterese verhindert Flattern an der Schwelle). **Ein erneuter manueller Klick gewinnt sofort**; nur ein unterhalb der Schutzuntergrenze liegender Modus wird beim nächsten periodischen Battery-Check (≤60s, oder sofort bei Netzstecker-Ereignis) erneut auf `balanced-powersave` gesetzt.
6. **Bewährter `platform_profile`-Guard aus `power-saver-epp-fix`** — `power-profiles-daemon` bleibt aktiv, wird durch ein systemd-Drop-in aber mit `--block-driver=platform_profile` gestartet. Der Helper setzt zuerst PPDs korrespondierendes Drei-Stufen-Basisprofil, wartet 0,2 Sekunden auf dessen CPU-Schreibvorgang und schreibt und verifiziert danach den exakten Vier-Stufen-EPP-Zustand und `platform_profile`. Damit bleibt die GNOME-/PPD-Integration erhalten, ohne dass PPD die Plattformvorgabe zurücksetzt. Der Uninstaller entfernt den Guard und startet PPD normal neu. Der native GNOME-Schalter wird nach Möglichkeit versteckt (siehe Risiko unten), damit die Nutzeroberfläche nur einen Regler anbietet.

## Architektur

### Repo-Layout

Repo: `github.com/shell-extensions/eppmode`, UUID `eppmode@yurij.de`. Anzeigename „EPP Power Modes" — über „Power" auf extensions.gnome.org auffindbar, über „EPP" eindeutig (Kollisionsprüfung: `epp` liefert dort und auf GitHub 0 Treffer; `power modes`/`power profile` sind beide dicht belegt, u.a. `voidbert/powermodes`).

```
eppmode/
├── metadata.json            # uuid, shell-version ["46","47","48","49"], gettext-domain; KEIN settings-schema
├── extension.js             # Indicator + 4-State-QuickMenuToggle + Lock-Switch + Native-Hide + Hardwarestatus
├── install.sh                # Kandidaten-Pfadsuche (user+system-wide), Helper/Sudoers/Units installieren
├── uninstall.sh
├── README.md
├── LICENSE
├── po/
│   ├── eppmode.pot        # aus extension.js via xgettext
│   ├── de.po
│   └── es.po
├── locale/                  # aus po/ gebaut (msgfmt), eingecheckt fürs EGO-ZIP
│   ├── de/LC_MESSAGES/eppmode.mo
│   └── es/LC_MESSAGES/eppmode.mo
└── tools/
    ├── eppmode-helper                # root bash: set|lock|unlock|reassert|battery-check|restore|status
    ├── eppmode-restore.service        # oneshot Boot-Restore
    ├── eppmode-reassert.service       # oneshot: helper reassert (Lock-Drift-Durchsetzung)
    ├── eppmode-reassert.path          # PathChanged=ACPI aggregate + platform-profile-0 provider
    ├── eppmode-reassert.timer         # 10s Backstop
    ├── eppmode-battery.service        # oneshot: helper battery-check
    ├── eppmode-battery.timer          # 60s Poll
    ├── 99-eppmode-power.rules         # udev: power_supply change → battery.service sofort
    └── build-locale.sh                  # xgettext + msgmerge + msgfmt, idempotent
```

**Kein GSettings/`prefs.js`**: Jeder gespeicherte Policy-Zustand muss ohnehin von root gelesen/geschrieben werden (EPP-Writes, Lock-Durchsetzung, Battery-Override) — eine zweite (dconf-)Quelle würde nur erneut die Art von Reconciliation-Bugs einladen, die diese Neugestaltung gerade vermeiden soll. Das Root-State-File ist die einzige persistente Wahrheit für Auswahl, Lock und Safety. Der sichtbare aktuelle Modus wird dagegen direkt aus den realen CPU-EPP-Werten in sysfs abgeleitet.

### State-Modell

Root-State-File `/var/lib/eppmode/state` (`0644`, key=value):
```
SELECTED=balanced-performance   # zuletzt vom Nutzer explizit gewählter Zustand (Restore-Ziel)
APPLIED=balanced-performance    # zuletzt vom Helper erfolgreich angewandter Zustand
LOCK=0                          # 1 = automatische Änderungen blockieren
SAFETY=0                        # 1 = Akku-Sicherheitsnetz erzwingt gerade balanced-powersave
PLATFORM_PENDING=               # gesetzt = platform_profile für APPLIED noch nicht vom Provider bestätigt
```

`PLATFORM_PENDING` existiert, weil auf realer ThinkPad-DYTC-Hardware
`platform_profile`-Schreibvorgänge intermittierend ohne erkennbaren
Kernel-Fehler verworfen werden können, während EPP und `power-profiles-daemon`
zuverlässig greifen (siehe `docs/power-saver-platform-profile-diagnose.de.md`).
EPP ist der eigentliche Hebel des Tools; ein unbestätigtes Plattformprofil ist
deshalb kein Fehlschlag des gesamten Modus, sondern ein separat verfolgter,
im Hintergrund nachgezogener Teilzustand.

Helper-Subkommandos (alle `require_root`, alle über `flock` auf dem State-File serialisiert):
- `set <state>` — validiert gegen die 4 IDs, schreibt und verifiziert zuerst die Hardware (erzwungen, ignoriert den Plattformprofil-Cooldown) und setzt danach `SELECTED=APPLIED=<state>` sowie `SAFETY=0`. Bleibt nur das Plattformprofil unbestätigt, gilt der Aufruf trotzdem als erfolgreich; `PLATFORM_PENDING` wird gesetzt. Manuell gewinnt sofort, unabhängig von Lock oder aktivem Sicherheitsnetz.
- `lock` / `unlock` — setzt `LOCK`, schreibt keine Hardware.
- `reassert` — bei `LOCK=1` oder aktivem Akku-Sicherheitsnetz wird `APPLIED` vollständig auf PPD, CPU-EPP und `platform_profile` zurückgeschrieben (Plattformprofil-Cooldown respektiert, im Gegensatz zu `set`). Bleibt dabei nur das Plattformprofil unbestätigt, wird `PLATFORM_PENDING` aktualisiert und `LOCK` **bleibt bestehen** — nur ein echter EPP-/PPD-Fehlschlag setzt `LOCK=0`. Bei `LOCK=0` wird externer Hardware-Drift stattdessen konsistent übernommen: `performance` → `performance`, `balanced` → `balanced-performance`, `low-power` zusammen mit `balance_power` → `balanced-powersave`, andernfalls standardmäßig → `power-saver` — außer das ausstehende Plattformprofil ist exakt das eigene noch unbestätigte von `APPLIED`; dann wird es als eigener Nachzieh-Versuch behandelt statt als fremder Drift. Anschließend werden PPD, EPP, Plattformprofil und State auf denselben Zielmodus gebracht.
- `battery-check` — liest UPower fail-closed (`gdbus call --system --dest org.freedesktop.UPower --object-path /org/freedesktop/UPower/devices/DisplayDevice ... Percentage` und `State`). Fehlende oder ungültige Daten verändern weder Hardware noch State. Unter 20% + discharging gilt `balanced-powersave` als Mindestprofil: Ist `SELECTED=power-saver`, bleibt beziehungsweise wird `power-saver` angewendet und `SAFETY=0` gesetzt; andernfalls wird bei Bedarf `SAFETY=1` und `APPLIED=balanced-powersave` gesetzt (`SELECTED` bleibt unberührt). Ab 25% oder bei externer Versorgung + `SAFETY==1` wird `SAFETY=0`, `APPLIED=SELECTED` und die ausgewählte Hardwarekonfiguration wiederhergestellt.
- `restore` — wendet `APPLIED` auf Hardware an (Boot-Restore).
- `status` — gibt State-File aus (Tests/README).

Hardware-Schreiblogik direkt aus `src/ppd-epp-override` übernommen: EPP-Schreib-Loop über `cpu[0-9]*` mit „nur schreiben wenn abweichend"-Guard, Verfügbarkeitsprüfung via `has_word()`/`energy_performance_available_preferences`, `platform_profile`-Mapping (beide `balanced-*` → `balanced`) mit Verfügbarkeitscheck gegen die jeweiligen `choices`. Auf neueren Kerneln sind die providerspezifischen Dateien unter `/sys/class/platform-profile/platform-profile-*` für Lesen und Verifikation maßgeblich. Schreibanforderungen gehen bevorzugt über den alten Sammelpfad unter `/sys/firmware/acpi`, damit der Kernel die Provider koordiniert; direkte Provider-Schreibvorgänge dienen nur als Fallback, wenn der Sammelpfad fehlt oder den Schreibzugriff ablehnt. Nach einer Schreibanforderung prüft der Helper die Provider alle 250 Millisekunden und akzeptiert den Zielwert erst nach zwei aufeinanderfolgenden Treffern; das Poll-Budget liegt bei rund 1,5 Sekunden mit einem einzigen Nachschreibimpuls. Reale Messung (`docs/power-saver-platform-profile-diagnose.de.md`) zeigt, dass ThinkPad-DYTC entweder sofort (< 1 s) konvergiert oder gar nicht — eine lange Retry-Leiter bringt nachweislich nichts. Bleibt der Provider nach dem Budget abweichend, gilt das als **Teilerfolg**: `apply_platform_profile()` liefert Rückgabecode `2`, der Helper markiert `PLATFORM_PENDING` statt den ganzen Aufruf scheitern zu lassen, und der periodische `reassert` zieht es nach (gebremst durch eine Cooldown-Datei, Standard 30 s, damit DYTC nicht mit Schreibversuchen bombardiert wird). Ist `power-profiles-daemon` aktiv, setzt der Helper ihn zuerst über `powerprofilesctl` auf das korrespondierende Basisprofil (`power-saver`, `balanced` oder `performance`) und wartet nur bei einer tatsächlichen Änderung 0,2 Sekunden, bevor er den exakten EPP-Wert schreibt. Das Drop-in `/etc/systemd/system/power-profiles-daemon.service.d/eppmode.conf` blockiert ausschließlich PPDs `platform_profile`-Treiber. CPU-EPP und PPD-Synchronisation sind verpflichtend und werden nach jedem Schreibvorgang verifiziert — nur bei ihrem Fehlschlag gilt der gesamte Aufruf als hart gescheitert (Rückgabecode `1`).

### Privilegien-Brücke

1:1 das `thinkpad-red-led`-Muster: `install.sh` schreibt `/etc/sudoers.d/eppmode` (`<user> ALL=(root) NOPASSWD: /usr/local/bin/eppmode-helper`, validiert mit `visudo -c -f`); Extension ruft `GLib.spawn_async_with_pipes(['sudo','-n','/usr/local/bin/eppmode-helper', ...args])` mit derselben `_isAuthError`/Setup-Dialog-Fallback-Logik wie in `thinkpad-red-led/extension.js:152-224`.

### Drift-Reassertion (Lock-Durchsetzung)

Mit blockiertem PPD-Plattformtreiber bleiben Firmware/ACPI-Hotkeys als realistische Drift-Quellen. Das bewährte Path+Timer-Muster aus `power-saver-epp-fix/systemd/ppd-epp-override.{path,timer}` wird wiederverwendet: `PathChanged=` beobachtet sowohl `/sys/firmware/acpi/platform_profile` als auch den ersten providerspezifischen Pfad `/sys/class/platform-profile/platform-profile-0/profile` und löst `eppmode-reassert.service` aus. Damit reagieren auch Systeme ohne alten ACPI-Sammelpfad sofort. Ein 10s-Timer bleibt Backstop für weitere Provider und Fälle ohne Datei-Änderungsereignis. Die Reconciliation selbst passiert im Helper: Lock setzt den gespeicherten Modus durch, ohne Lock wird der externe Wechsel auf einen konsistenten der vier Modi übernommen. Die Extension braucht dadurch keine `systemctl`-Rechte.

### Akku-Sicherheitsnetz

Root-seitig, Poll-basiert (kein Dauerprozess, kein GJS-D-Bus-Abo nötig): `eppmode-battery.timer` alle 60s + `99-eppmode-power.rules` (udev `power_supply`-`change` → sofortiger `battery-check`) für schnelle Reaktion bei Netzstecker-Ereignissen. Root-seitig statt in der Extension, damit es GNOME-Shell-Neustarts/Extension-Deaktivierung übersteht und denselben verifizierten Hardwarepfad wie manuelle Änderungen verwendet. Das Sicherheitsnetz definiert `balanced-powersave` als Mindestschutz und lässt den sparsameren, manuell gewählten `power-saver` unverändert aktiv.

### UI + natives Toggle verstecken

`EppMenu extends QuickSettings.QuickMenuToggle` (4 `PopupMenu.PopupBaseMenuItem`-Zeilen mit `emblem-ok-symbolic`-Tick, exakt wie `thinkpad-red-led/extension.js:48-67`) + `PopupMenu.PopupSeparatorMenuItem` + eine von `PopupMenu.PopupSwitchMenuItem` abgeleitete Lock-Zeile, die beim Umschalten das Menü offen hält. `EppIndicator extends QuickSettings.SystemIndicator` pusht das Menü; `enable()`/`disable()` wie `thinkpad-red-led/extension.js:515-552`. Ein `Gio.FileMonitor` auf dem State-Verzeichnis aktualisiert Lock und Hardwarestatus bei Helper-Änderungen. Zusätzlich liest die Extension beim Öffnen des Menüs und alle fünf Sekunden alle vorhandenen CPU-EPP-Dateien direkt aus sysfs. Die vier exakten EPP-Werte werden auf die vier bekannten Modi abgebildet; CPU-Abweichungen erscheinen als „Uneinheitlich", nicht lesbare beziehungsweise unbekannte EPP-Werte als „Unbekannt". Das optionale `platform_profile` ersetzt diese Vier-Stufen-Anzeige nicht. Ein vom Helper nach fehlgeschlagener Durchsetzung zurückgesetztes `LOCK=0` wird einmalig als Benachrichtigung angezeigt. Ist `PLATFORM_PENDING` im State-File gesetzt, zeigt eine zusätzliche, nicht interaktive Menüzeile oberhalb der Moduswahl „Plattformprofil ausstehend" — keine Benachrichtigung, kein Warn-Icon auf der Kachel, da der Modus selbst (EPP-basiert) bereits aktiv ist.

Kachel-Titel „Energie"/„Power"/„Energía" (statt des zu langen „Energieoptionen", siehe Beschriftungstabelle oben), Untertitel = Kurzform des aktiven Modus. Menü-Header: `this.menu.setHeader('power-profile-balanced-symbolic', 'EPP Power Modes')` — Eigenname, bewusst nicht übersetzt; Icon identisch mit dem des nativen Buttons (Teil des Shell-Icon-Themes).

**Energieeinstellungen-Link**: kompensiert den mit dem nativen Schalter verschwindenden Settings-Einstieg (siehe Risiko-Absatz unten). Ganz unten im Menü, nach dem Lock-Switch, exakt nach dem Vorbild des nativen `PowerProfilesToggle` (`ui/status/powerProfiles.js:72-74` im gestrippten `gnome-shell`-Binary, per `gresource extract` verifiziert — siehe unten):

```js
this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
this.menu.addSettingsAction(_('Power Settings'), 'gnome-power-panel.desktop');
```

`addSettingsAction` (`ui/popupMenu.js:622-637`) bewusst statt `addAction`: erledigt `Main.overview.hide()`, `Main.panel.closeQuickSettings()`, `app.activate()`, das `menuItem.visible = Main.sessionMode.allowSettings`-Gate (blendet den Eintrag korrekt am Sperrbildschirm aus) und die `_settingsActions`-Registrierung für Session-Mode-Wechsel — alles gratis. Das Muster aus `loadshed/extension.js:248-251` (manuelles `menu.close(PopupAnimation.FADE)`) ist für die *eigenen* Prefs richtig, deckt den Session-Mode-Lebenszyklus aber nicht ab und wird hier nicht verwendet.

**Risiko, offen als Best-Effort markiert**: Das Verstecken des nativen Schalters (`Main.panel.statusArea.quickSettings._powerProfiles`) nutzt eine undokumentierte, versionsfragile interne GNOME-Shell-Eigenschaft. Für Shell 46 verifiziert (`ui/panel.js:549`: `this._powerProfiles = new PowerProfileStatus.Indicator();`) — die Shell-UI-JS ist entgegen früherer Annahme lesbar, sie liegt als GResource in `/usr/lib/gnome-shell/libshell-14.so`:
```bash
gresource extract /usr/lib/gnome-shell/libshell-14.so /org/gnome/shell/ui/panel.js
```
Für 47-49 bleibt die Eigenschaft unbestätigt — verifiziert ist die heutige Existenz, nicht die künftige Stabilität. Komplett in `try/catch`: schlägt es fehl oder ist die Eigenschaft umbenannt, bleiben beide Schalter sichtbar (unser Toggle mit klar unterscheidbarem Icon/Label) statt die Extension zu zerbrechen — nie eine harte Anforderung.

### Mehrsprachigkeit

Zielsprachen: Englisch (Quellsprache/msgid, kein `en.po` nötig — EGO-Konvention), Deutsch, Spanisch. `initTranslations()` (`extensions/sharedInternals.js:120-131`) läuft automatisch beim Laden der Extension und bindet an `<ext>/locale`, sobald dieses Verzeichnis existiert — kein manueller Aufruf in `enable()` nötig. Neben `gettext`/`ngettext` steht `pgettext(context, str)` zur Verfügung (`sharedInternals.js:169-172`, `GLib.dpgettext2`).

**`pgettext` statt `gettext` für die Modus-Labels**: „Performance" tritt sowohl als volles Menü-Label als auch als Kachel-Kurzform auf. Mit nur einer `msgid` könnten Übersetzer beide Rollen nicht getrennt kürzen — im Spanischen müssen „Ahorro de energía" (Menü) und „Ahorro" (Kachel) auseinandergehalten werden. Daher zwei Kontexte:

```js
import {gettext as _, pgettext} from 'resource:///org/gnome/shell/extensions/extension.js';

pgettext('power mode', 'Performance')    // Menü, volle Form
pgettext('tile subtitle', 'Performance') // Kachel, ≤ 14 Zeichen
```

In `de.po`/`es.po` als Kommentar festhalten, dass Strings mit Kontext `tile subtitle` die 14-Zeichen-Grenze einhalten müssen — sonst reproduziert eine spätere Übersetzung den Abschneide-Fehler, der diese Beschriftungsrunde ausgelöst hat. `tools/build-locale.sh` erzeugt `po/eppmode.pot` per `xgettext` aus `extension.js`, merged per `msgmerge` in `de.po`/`es.po` und baut per `msgfmt` die `.mo`-Dateien nach `locale/`.

### install.sh / uninstall.sh

`install.sh`: Kandidaten-Pfadsuche für Helper/Units (User- und System-weite Extension-Installationspfade, wie `thinkpad-red-led/install.sh`), Hardware-Vorprüfungen wie in `power-saver-epp-fix/install.sh:146-164`, Sudoers+`visudo -c`, alle Units + udev-Regel installieren, `daemon-reload`, `enable --now`.

`uninstall.sh` — beide in der Vorgänger-Sitzung gefundenen Bugs von Anfang an vermieden:
- Units **einzeln** disablen/stoppen (niemals `systemctl disable --now A B C` in einem Aufruf — schlägt atomar fehl, wenn eine Unit fehlt, und das still).
- Enable-Symlinks unter `*.target.wants/` explizit als Backstop entfernen, nicht nur auf erfolgreiches `disable` vertrauen.

## Verifikation (sobald implementiert)

Auf einem echten GNOME-46/Ubuntu-24.04/`intel_pstate`-Gerät:

1. Install: `eppmode-helper status` prüfen, `systemctl is-enabled` für Path/Timer/Restore.
2. Alle 4 Zustände durchklicken, `energy_performance_preference` (alle CPUs) + `platform_profile` gegen die Tabelle prüfen; Menü-Label und Kachel-Untertitel in allen drei Sprachen (`LANG=de_DE.UTF-8`, `LANG=es_ES.UTF-8`, `LANG=en_US.UTF-8`) auf korrekten Text und fehlende Abschneidung prüfen.
3. Natives Toggle-Verstecken verifizieren: Property-Existenz per `gresource extract /usr/lib/gnome-shell/libshell-14.so /org/gnome/shell/ui/panel.js` gegen die jeweils installierte Shell-Version prüfen, dann Fallback testen, indem der Property-Name testweise falsch gesetzt wird — beide Toggles müssen sichtbar bleiben.
3b. Energieeinstellungen-Link: Klick öffnet `gnome-control-center power`, Quick-Settings-Menü schließt sich; Eintrag ist am Sperrbildschirm (`allowSettings=false`) ausgeblendet.
4. Lock + simulierte Drift: bei `power-saver` und gelöstem Lock `platform_profile` manuell auf `balanced` schreiben → innerhalb ~1s werden PPD, CPU-EPP, Plattform und State konsistent auf `balanced-performance` übernommen. Mit Lock → wird stattdessen `power-saver` mit EPP `power` und Plattform `low-power` wiederhergestellt (`journalctl -u eppmode-reassert.service`).
5. Akku-Sicherheitsnetz ohne echtes Leerlaufen: `FAKE_PERCENT`/`FAKE_STATE`-Env-Var-Hook in `battery-check` für Tests (z.B. bei ausgewähltem `performance`: `sudo FAKE_STATE=discharging FAKE_PERCENT=15 eppmode-helper battery-check` → `SAFETY=1`, `APPLIED=balanced-powersave`; danach `FAKE_STATE=charging FAKE_PERCENT=50` → Restore auf `SELECTED`). Zusätzlich unter 20% `power-saver` manuell wählen und einen weiteren `battery-check` ausführen: `SELECTED=APPLIED=power-saver` und `SAFETY=0` müssen erhalten bleiben.
6. Persistenz und Istwert: Zustand wählen, GNOME Shell neu starten → Toggle zeigt den direkt gelesenen CPU-EPP-Hardwarezustand. Neustart → `eppmode-restore.service` wendet `APPLIED` an, die Extension zeigt anschließend dessen verifiziertes EPP-Ergebnis und `battery-check` korrigiert bei Bedarf selbst. Bei deaktiviertem Lock CPU-EPP extern ändern → die Kachel muss spätestens nach fünf Sekunden den entsprechenden der vier Modi beziehungsweise bei abweichenden CPU-Werten „Uneinheitlich" anzeigen.

## Kritische Dateien als Vorlage

- `/home/yurij/web/git/thinkpad-red-led@juanmagd.dev/extension.js` — QuickMenuToggle/SystemIndicator-Muster, Sudo-Helper-Brücke + Setup-Dialog-Fallback, State-File-Reflection
- `/home/yurij/web/git/power-saver-epp-fix/src/ppd-epp-override` — EPP-/platform_profile-Sysfs-Schreiblogik
- `/home/yurij/web/git/power-saver-epp-fix/systemd/ppd-epp-override.path` + `.timer` — Drift-Watch-Muster
- `/home/yurij/web/git/power-saver-epp-fix/udev/99-ppd-epp-override.rules` — power_supply-Change-Trigger
- `/home/yurij/web/git/thinkpad-red-led@juanmagd.dev/install.sh` + `/home/yurij/web/git/power-saver-epp-fix/uninstall.sh` — Install-Pfadsuche + korrekter (Bug-freier) Uninstall
- `/home/yurij/web/git/thinkpad-red-led@juanmagd.dev/tools/thinkpad-red-led-restore.service` — Boot-Restore-Unit-Vorlage
- `/home/yurij/web/git/gold-silver-price@arononak.github.io/` (extension.js) — `PopupSwitchMenuItem`-Muster für Lock
- `gresource extract /usr/lib/gnome-shell/libshell-14.so /org/gnome/shell/ui/status/powerProfiles.js` + `.../ui/popupMenu.js` + `.../ui/panel.js` — nativer `addSettingsAction`-Aufbau, `allowSettings`-Gate, bestätigte `_powerProfiles`-Eigenschaft (Shell 46)
- `gresource extract /usr/lib/gnome-shell/libshell-14.so /org/gnome/shell/extensions/sharedInternals.js` — `initTranslations()`/`gettext()`/`pgettext()`-API der Extension-Basisklasse
- `/usr/share/locale-langpack/{de,es}/LC_MESSAGES/gnome-shell.mo` — Referenz für die offiziellen deutschen/spanischen GNOME-Übersetzungen der Modus-Namen
