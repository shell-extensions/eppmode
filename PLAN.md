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
   - `balanced-powersave` → EPP `balance_power`, platform_profile `balanced`
   - `balanced-performance` → EPP `balance_performance`, platform_profile `balanced`
   - `performance` → EPP `performance`, platform_profile `performance`

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
5. **Akku-Sicherheitsnetz** (Ausnahme, die sogar Lock übersteuert): Kein selbstgebautes Lastmonitoring nötig — verifiziert, dass Intel-CPUs im Leerlauf unabhängig von EPP über C-States (C1–C10 bestätigt) selbst herunterregeln. Stattdessen wird **UPowers Akkustand direkt** gelesen (`org.freedesktop.UPower`, `DisplayDevice`) — dieselbe Kennzahl, auf der auch GNOMEs eigenes `power-saver-profile-on-low-battery`-Feature basiert. Unter 20% *und* im Akkubetrieb wird automatisch auf `balanced-powersave` erzwungen, unabhängig von Lock. Ab 25% oder bei Netzbetrieb wird automatisch der zuletzt gewählte Zustand wiederhergestellt (Hysterese verhindert Flattern an der Schwelle). **Ein erneuter manueller Klick gewinnt aber sofort** — auch während das Sicherheitsnetz aktiv heruntergeschaltet hat; der nächste periodische Battery-Check (≤60s, oder sofort bei Netzstecker-Ereignis) schaltet bei Bedarf erneut ein.
6. **`power-profiles-daemon` wird komplett umgangen** — eigene State-Maschine, eigener Root-Helper schreibt EPP/`platform_profile` direkt. Der native GNOME-Schalter wird nach Möglichkeit versteckt (siehe Risiko unten), um zwei konkurrierende Regler zu vermeiden.

## Architektur

### Repo-Layout

Repo: `github.com/shell-extensions/epp-modes`, UUID `epp-modes@shell-extensions.github.io`. Anzeigename „EPP Power Modes" — über „Power" auf extensions.gnome.org auffindbar, über „EPP" eindeutig (Kollisionsprüfung: `epp` liefert dort und auf GitHub 0 Treffer; `power modes`/`power profile` sind beide dicht belegt, u.a. `voidbert/powermodes`).

```
epp-modes/
├── metadata.json            # uuid, shell-version ["46","47","48","49"], gettext-domain; KEIN settings-schema
├── extension.js             # Indicator + 4-State-QuickMenuToggle + Lock-Switch + Native-Hide + FileMonitor
├── install.sh                # Kandidaten-Pfadsuche (user+system-wide), Helper/Sudoers/Units installieren
├── uninstall.sh
├── README.md
├── LICENSE
├── po/
│   ├── epp-modes.pot        # aus extension.js via xgettext
│   ├── de.po
│   └── es.po
├── locale/                  # aus po/ gebaut (msgfmt), eingecheckt fürs EGO-ZIP
│   ├── de/LC_MESSAGES/epp-modes.mo
│   └── es/LC_MESSAGES/epp-modes.mo
└── tools/
    ├── epp-modes-helper                # root bash: set|lock|unlock|reassert|battery-check|restore|status
    ├── epp-modes-restore.service        # oneshot Boot-Restore
    ├── epp-modes-reassert.service       # oneshot: helper reassert (Lock-Drift-Durchsetzung)
    ├── epp-modes-reassert.path          # PathChanged=/sys/firmware/acpi/platform_profile
    ├── epp-modes-reassert.timer         # 10s Backstop
    ├── epp-modes-battery.service        # oneshot: helper battery-check
    ├── epp-modes-battery.timer          # 60s Poll
    ├── 99-epp-modes-power.rules         # udev: power_supply change → battery.service sofort
    └── build-locale.sh                  # xgettext + msgmerge + msgfmt, idempotent
```

**Kein GSettings/`prefs.js`**: Jeder gespeicherte Zustand muss ohnehin von root gelesen/geschrieben werden (EPP-Writes, Lock-Durchsetzung, Battery-Override) — eine zweite (dconf-)Quelle würde nur erneut die Art von Reconciliation-Bugs einladen, die diese Neugestaltung gerade vermeiden soll. Root-State-File ist die einzige Wahrheit, exakt wie bei `thinkpad-red-led`.

### State-Modell

Root-State-File `/var/lib/epp-modes/state` (`0644`, key=value):
```
SELECTED=balanced-performance   # zuletzt vom Nutzer explizit gewählter Zustand (Restore-Ziel)
APPLIED=balanced-performance    # aktuell tatsächlich gesetztes EPP
LOCK=0                          # 1 = automatische Änderungen blockieren
SAFETY=0                        # 1 = Akku-Sicherheitsnetz erzwingt gerade balanced-powersave
```

Helper-Subkommandos (alle `require_root`, alle über `flock` auf dem State-File serialisiert):
- `set <state>` — validiert gegen die 4 IDs, setzt **immer sofort** `SELECTED=APPLIED=<state>`, schreibt Hardware, setzt `SAFETY=0`. Manuell gewinnt immer, unabhängig von Lock oder aktivem Sicherheitsnetz.
- `lock` / `unlock` — setzt `LOCK`, schreibt keine Hardware.
- `reassert` — no-op wenn `LOCK=0`; bei `LOCK=1` schreibt erneut `APPLIED` auf Hardware (idempotent).
- `battery-check` — liest UPower (`gdbus call --system --dest org.freedesktop.UPower --object-path /org/freedesktop/UPower/devices/DisplayDevice ... Percentage` und `State`; `State==2` = discharging). Unter 20% + discharging + `SAFETY!=1` → `SAFETY=1`, `APPLIED=balanced-powersave`, Hardware schreiben (`SELECTED` bleibt unberührt). Ab 25% oder nicht discharging + `SAFETY==1` → `SAFETY=0`, `APPLIED=SELECTED`, Hardware schreiben.
- `restore` — wendet `APPLIED` auf Hardware an (Boot-Restore).
- `status` — gibt State-File aus (Tests/README).

Hardware-Schreiblogik direkt aus `src/ppd-epp-override` übernommen: EPP-Schreib-Loop über `cpu[0-9]*` mit „nur schreiben wenn abweichend"-Guard, Verfügbarkeitsprüfung via `has_word()`/`energy_performance_available_preferences`, `platform_profile`-Mapping (beide `balanced-*` → `balanced`) mit Verfügbarkeitscheck gegen `platform_profile_choices`. Anders als im alten Projekt wird `platform_profile` jetzt **immer** mitgeschrieben (nicht optional) — die Zwei-Werkzeuge-Ambiguität, die dort den Guard optional machte, entfällt, da `power-profiles-daemon` komplett umgangen wird.

### Privilegien-Brücke

1:1 das `thinkpad-red-led`-Muster: `install.sh` schreibt `/etc/sudoers.d/epp-modes` (`<user> ALL=(root) NOPASSWD: /usr/local/bin/epp-modes-helper`, validiert mit `visudo -c -f`); Extension ruft `GLib.spawn_async_with_pipes(['sudo','-n','/usr/local/bin/epp-modes-helper', ...args])` mit derselben `_isAuthError`/Setup-Dialog-Fallback-Logik wie in `thinkpad-red-led/extension.js:152-224`.

### Drift-Reassertion (Lock-Durchsetzung)

Einzige realistische Drift-Quelle nach Wegfall von `power-profiles-daemon`: Firmware/ACPI-Hotkeys, die `/sys/firmware/acpi/platform_profile` direkt ändern. Wiederverwendung des bewährten Path+Timer-Musters aus `power-saver-epp-fix/systemd/ppd-epp-override.{path,timer}` — `PathChanged=/sys/firmware/acpi/platform_profile` löst `epp-modes-reassert.service` aus, ein 10s-Timer ist Backstop für Fälle ohne Datei-Änderungsereignis. Die Durchsetzung selbst passiert im Helper (`reassert` prüft `LOCK`), nicht durch Enable/Disable der Units — die Extension braucht dadurch keine `systemctl`-Rechte.

### Akku-Sicherheitsnetz

Root-seitig, Poll-basiert (kein Dauerprozess, kein GJS-D-Bus-Abo nötig): `epp-modes-battery.timer` alle 60s + `99-epp-modes-power.rules` (udev `power_supply`-`change` → sofortiger `battery-check`) für schnelle Reaktion bei Netzstecker-Ereignissen. Root-seitig statt in der Extension, damit es GNOME-Shell-Neustarts/Extension-Deaktivierung übersteht — dieselbe Robustheits-Überlegung wie beim `power-profiles-daemon`-Bypass insgesamt.

### UI + natives Toggle verstecken

`EppMenu extends QuickSettings.QuickMenuToggle` (4 `PopupMenu.PopupBaseMenuItem`-Zeilen mit `emblem-ok-symbolic`-Tick, exakt wie `thinkpad-red-led/extension.js:48-67`) + `PopupMenu.PopupSeparatorMenuItem` + `PopupMenu.PopupSwitchMenuItem` für Lock (Muster aus `gold-silver-price`). `EppIndicator extends QuickSettings.SystemIndicator` pusht das Menü; `enable()`/`disable()` wie `thinkpad-red-led/extension.js:515-552`. Ein `Gio.FileMonitor` auf dem State-File hält die UI live synchron, wenn Battery-Check oder Reassert im Hintergrund etwas ändern.

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

In `de.po`/`es.po` als Kommentar festhalten, dass Strings mit Kontext `tile subtitle` die 14-Zeichen-Grenze einhalten müssen — sonst reproduziert eine spätere Übersetzung den Abschneide-Fehler, der diese Beschriftungsrunde ausgelöst hat. `tools/build-locale.sh` erzeugt `po/epp-modes.pot` per `xgettext` aus `extension.js`, merged per `msgmerge` in `de.po`/`es.po` und baut per `msgfmt` die `.mo`-Dateien nach `locale/`.

### install.sh / uninstall.sh

`install.sh`: Kandidaten-Pfadsuche für Helper/Units (User- und System-weite Extension-Installationspfade, wie `thinkpad-red-led/install.sh`), Hardware-Vorprüfungen wie in `power-saver-epp-fix/install.sh:146-164`, Sudoers+`visudo -c`, alle Units + udev-Regel installieren, `daemon-reload`, `enable --now`.

`uninstall.sh` — beide in der Vorgänger-Sitzung gefundenen Bugs von Anfang an vermieden:
- Units **einzeln** disablen/stoppen (niemals `systemctl disable --now A B C` in einem Aufruf — schlägt atomar fehl, wenn eine Unit fehlt, und das still).
- Enable-Symlinks unter `*.target.wants/` explizit als Backstop entfernen, nicht nur auf erfolgreiches `disable` vertrauen.

## Verifikation (sobald implementiert)

Auf einem echten GNOME-46/Ubuntu-24.04/`intel_pstate`-Gerät:

1. Install: `epp-modes-helper status` prüfen, `systemctl is-enabled` für Path/Timer/Restore.
2. Alle 4 Zustände durchklicken, `energy_performance_preference` (alle CPUs) + `platform_profile` gegen die Tabelle prüfen; Menü-Label und Kachel-Untertitel in allen drei Sprachen (`LANG=de_DE.UTF-8`, `LANG=es_ES.UTF-8`, `LANG=en_US.UTF-8`) auf korrekten Text und fehlende Abschneidung prüfen.
3. Natives Toggle-Verstecken verifizieren: Property-Existenz per `gresource extract /usr/lib/gnome-shell/libshell-14.so /org/gnome/shell/ui/panel.js` gegen die jeweils installierte Shell-Version prüfen, dann Fallback testen, indem der Property-Name testweise falsch gesetzt wird — beide Toggles müssen sichtbar bleiben.
3b. Energieeinstellungen-Link: Klick öffnet `gnome-control-center power`, Quick-Settings-Menü schließt sich; Eintrag ist am Sperrbildschirm (`allowSettings=false`) ausgeblendet.
4. Lock + simulierte Drift: ohne Lock `platform_profile` manuell umschreiben → bleibt (kein Revert). Mit Lock → wird innerhalb ~1s zurückgesetzt (`journalctl -u epp-modes-reassert.service`).
5. Akku-Sicherheitsnetz ohne echtes Leerlaufen: `FAKE_PERCENT`/`FAKE_STATE`-Env-Var-Hook in `battery-check` für Tests (z.B. `sudo FAKE_STATE=discharging FAKE_PERCENT=15 epp-modes-helper battery-check` → `SAFETY=1`, `APPLIED=balanced-powersave`; danach `FAKE_STATE=charging FAKE_PERCENT=50` → Restore auf `SELECTED`). Zusätzlich: manueller Klick während aktivem Sicherheitsnetz muss sofort greifen.
6. Persistenz: Zustand wählen, GNOME Shell neu starten → Toggle zeigt gespeicherten Zustand. Neustart → `epp-modes-restore.service` wendet `APPLIED` an, `battery-check` korrigiert bei Bedarf selbst.

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
