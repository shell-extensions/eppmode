import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

import { Extension, InjectionManager, gettext as _, pgettext } from 'resource:///org/gnome/shell/extensions/extension.js';

const HELPER_PATH = '/usr/local/bin/epp-modes-helper';
const STATE_DIR_PATH = '/var/lib/epp-modes';
const STATE_FILE_NAME = 'state';
const STATE_FILE_PATH = `${STATE_DIR_PATH}/${STATE_FILE_NAME}`;
const TEXT_DECODER = new TextDecoder('utf-8');

// Row directly below hotspot's own fixed TARGET_POSITION=4 (hotspot@yurij.de),
// left column of a 2-column grid (even index). hotspotIndex+1 (odd) landed in
// hotspot's own row instead — same row, not the next one. loadshed positions
// itself independently to 7 (right column of this same row).
const EPP_POSITION = 6;

// Icon names match GNOME's own PROFILE_PARAMS in ui/status/powerProfiles.js,
// so our modes visually line up with the native power-saver/performance icons.
const MODES = [
    {
        id: 'power-saver',
        icon: 'power-profile-power-saver-symbolic',
        menuLabel: () => pgettext('power mode', 'Power Saver'),
        tileLabel: () => pgettext('tile subtitle', 'Saver'),
    },
    {
        id: 'balanced-powersave',
        icon: 'power-profile-balanced-symbolic',
        menuLabel: () => pgettext('power mode', 'Balanced-Saver'),
        tileLabel: () => pgettext('tile subtitle', 'Balanced −'),
    },
    {
        id: 'balanced-performance',
        icon: 'power-profile-balanced-symbolic',
        menuLabel: () => pgettext('power mode', 'Balanced-Performance'),
        tileLabel: () => pgettext('tile subtitle', 'Balanced +'),
    },
    {
        id: 'performance',
        icon: 'power-profile-performance-symbolic',
        menuLabel: () => pgettext('power mode', 'Performance'),
        tileLabel: () => pgettext('tile subtitle', 'Performance'),
    },
];

function parseStateFile(text) {
    const state = {};
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#'))
            continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1)
            continue;
        state[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
    return state;
}

const EppMenu = GObject.registerClass(
class EppMenu extends QuickSettings.QuickMenuToggle {
    _init(indicator) {
        super._init({
            title: _('Power'),
            iconName: 'power-profile-balanced-symbolic',
        });

        this._indicator = indicator;
        this.menu.setHeader('power-profile-balanced-symbolic', 'EPP Power Modes');

        this._modeItems = new Map();
        const modesSection = new PopupMenu.PopupMenuSection();

        for (const mode of MODES) {
            const menuItem = new PopupMenu.PopupBaseMenuItem();
            const box = new St.BoxLayout({ vertical: false, style_class: 'popup-menu-item-content' });
            const icon = new St.Icon({ icon_name: mode.icon, style_class: 'popup-menu-icon' });
            box.add_child(icon);
            const label = new St.Label({
                text: mode.menuLabel(),
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
            });
            box.add_child(label);
            const tick = new St.Icon({ icon_name: 'emblem-ok-symbolic', style_class: 'popup-menu-icon', visible: false });
            box.add_child(tick);
            menuItem._tick = tick;
            menuItem.actor.add_child(box);
            menuItem.connect('activate', () => this._applyMode(mode.id));
            modesSection.addMenuItem(menuItem);
            this._modeItems.set(mode.id, menuItem);
        }
        this.menu.addMenuItem(modesSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._lockItem = new PopupMenu.PopupSwitchMenuItem(_('Lock'), false);
        this._lockChangedId = this._lockItem.connect('toggled', (item, state) => this._setLock(state));
        this.menu.addMenuItem(this._lockItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addSettingsAction(_('Power Settings'), 'gnome-power-panel.desktop');

        this._busy = false;
        this._monitor = null;
        this._monitorChangedId = 0;
        this._refreshSourceId = 0;
        this._appliedId = undefined;
        this._previousId = null;
        this._lastChangeWasClick = false;

        this._clickedId = this.connect('clicked', () => this._cycleMode());
        this._menuOpenId = this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen)
                this._refreshFromStateFile();
        });

        this._startStateMonitor();
        this._refreshFromStateFile();
    }

    _runCommand(command) {
        return new Promise((resolve, reject) => {
            try {
                const [success, pid, , , stderr] = GLib.spawn_async_with_pipes(
                    null,
                    command,
                    null,
                    GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
                    null
                );

                if (!success) {
                    reject(new Error('Failed to start the command.'));
                    return;
                }

                const stderrStream = new Gio.DataInputStream({
                    base_stream: new Gio.UnixInputStream({ fd: stderr, close_fd: true }),
                });

                let errorOutput = '';
                const readStderr = () => {
                    stderrStream.read_line_async(GLib.PRIORITY_DEFAULT, null, (source, res) => {
                        const [line] = source.read_line_finish(res);
                        if (line) {
                            errorOutput += TEXT_DECODER.decode(line) + '\n';
                            readStderr();
                        }
                    });
                };
                readStderr();

                GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid, (p, status) => {
                    try {
                        if (GLib.spawn_check_exit_status(status)) {
                            resolve();
                        } else {
                            reject(new Error(`Command failed with status ${status}\n${errorOutput}`));
                        }
                    } catch (error) {
                        error.stderrOutput = errorOutput;
                        reject(error);
                    }
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    _isAuthError(error) {
        const message = (error?.message || '').toLowerCase() + (error?.stderrOutput || '').toLowerCase();
        return message.includes('sudo') && (
            message.includes('password') ||
            message.includes('not allowed') ||
            message.includes('permission denied') ||
            message.includes('no tty') ||
            message.includes('authentication')
        );
    }

    _notifySetupRequired() {
        Main.notify(_('Setup required'), _('Run the install script once to allow passwordless access to the helper.'));
    }

    _runHelperCommand(args) {
        const sudoBin = GLib.find_program_in_path('sudo');
        if (!sudoBin) {
            Main.notify(_('Error'), _('sudo was not found on this system.'));
            const error = new Error('sudo not found');
            error.handled = true;
            return Promise.reject(error);
        }

        if (!GLib.file_test(HELPER_PATH, GLib.FileTest.IS_EXECUTABLE)) {
            this._notifySetupRequired();
            this._openSetupDialog();
            const error = new Error('helper not installed');
            error.handled = true;
            return Promise.reject(error);
        }

        return this._runCommand([sudoBin, '-n', HELPER_PATH, ...args]).catch(error => {
            if (this._isAuthError(error)) {
                this._notifySetupRequired();
                this._openSetupDialog();
                error.handled = true;
            }
            return Promise.reject(error);
        });
    }

    _readStateFile() {
        try {
            if (!GLib.file_test(STATE_FILE_PATH, GLib.FileTest.IS_REGULAR))
                return null;
            const [ok, contents] = GLib.file_get_contents(STATE_FILE_PATH);
            if (!ok || contents === null)
                return null;
            return parseStateFile(TEXT_DECODER.decode(contents));
        } catch (error) {
            console.error('EPP Power Modes: error reading state file', error);
            return null;
        }
    }

    _startStateMonitor() {
        try {
            // The helper writes the state file atomically (mktemp + mv -f,
            // tools/epp-modes-helper), replacing the inode at STATE_FILE_PATH
            // on every write — a monitor_file() watch on the single file
            // typically loses its binding after the first such rename.
            // Watch the directory instead and filter on the basename (it also
            // contains .lock, touched on every helper call, and .state.XXXXXX
            // from mktemp).
            const dir = Gio.File.new_for_path(STATE_DIR_PATH);
            this._monitor = dir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            this._monitor.set_rate_limit(0);
            this._monitorChangedId = this._monitor.connect('changed', (monitor, file, otherFile) => {
                const isStateFile = f => f?.get_basename() === STATE_FILE_NAME;
                if (!isStateFile(file) && !isStateFile(otherFile))
                    return;
                this._queueRefresh();
            });
        } catch (error) {
            console.error('EPP Power Modes: could not watch state directory', error);
        }
    }

    // A single mv can surface as several events depending on the GIO backend
    // (RENAMED, or DELETED+CREATED+CHANGES_DONE_HINT) — coalesce into one read.
    _queueRefresh() {
        if (this._refreshSourceId)
            return;
        this._refreshSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._refreshSourceId = 0;
            this._refreshFromStateFile();
            return GLib.SOURCE_REMOVE;
        });
    }

    _refreshFromStateFile() {
        const state = this._readStateFile();
        this._setLockIndicator(state?.LOCK === '1');
        // While our own `set` is in flight the helper has often already
        // written the target to disk before the promise resolves; skipping
        // the mode update here avoids a visible flicker back to the old
        // value. _applyMode()'s own .then()/.catch() reconciles afterwards.
        if (this._busy)
            return;
        this._setAppliedMode(state?.APPLIED ?? 'balanced-performance');
    }

    _setLockIndicator(locked) {
        this._lockItem.block_signal_handler(this._lockChangedId);
        this._lockItem.setToggleState(locked);
        this._lockItem.unblock_signal_handler(this._lockChangedId);
    }

    _setAppliedMode(id, { viaClick = false } = {}) {
        const mode = MODES.find(m => m.id === id) ?? MODES[2];

        // Track what was active immediately before this change, and whether
        // the change came from a tile click, so _cycleMode() can decide
        // between "jump back to previous" and "keep cycling forward".
        // Guarded on `!== undefined` so the very first sync at startup never
        // records a bogus "previous" state.
        const changed = this._appliedId !== undefined && this._appliedId !== mode.id;
        if (changed) {
            this._previousId = this._appliedId;
            this._lastChangeWasClick = viaClick;
        }
        this._appliedId = mode.id;

        for (const [modeId, item] of this._modeItems)
            item._tick.visible = modeId === mode.id;
        this.iconName = mode.icon;
        this._indicator.icon_name = mode.icon;
        this.subtitle = mode.tileLabel();
        this.menu.setHeader(mode.icon, 'EPP Power Modes');
        // Mirror GNOME's own PowerProfilesToggle: highlighted only away from
        // the balanced middle, i.e. for the two non-balanced extremes.
        this.checked = mode.id === 'power-saver' || mode.id === 'performance';
    }

    // Click on the tile body: one step forward, wrapping around — unless the
    // last change came from somewhere else (menu selection, external drift),
    // in which case the first click jumps back to whatever was active before
    // that, mirroring GNOME's own PowerProfilesToggle. A second click right
    // after continues the forward cycle.
    _cycleMode() {
        const currentIndex = MODES.findIndex(m => m.id === this._appliedId);
        const base = currentIndex === -1 ? 0 : currentIndex;
        const sequentialNext = MODES[(base + 1) % MODES.length].id;
        const target = this._lastChangeWasClick ? sequentialNext : (this._previousId ?? sequentialNext);
        this._applyMode(target, { viaClick: true });
    }

    _applyMode(id, { viaClick = false } = {}) {
        if (this._busy)
            return;
        this._busy = true;

        this._runHelperCommand(['set', id]).then(() => {
            this._busy = false;
            this._setAppliedMode(id, { viaClick });
        }).catch(error => {
            this._busy = false;
            if (!error?.handled)
                Main.notify(_('Error'), _('Could not apply the power mode.'));
            console.error('EPP Power Modes: error applying mode', error);
            this._refreshFromStateFile();
        });
    }

    _setLock(state) {
        this._runHelperCommand([state ? 'lock' : 'unlock']).catch(error => {
            if (!error?.handled)
                Main.notify(_('Error'), _('Could not change the lock state.'));
            console.error('EPP Power Modes: error setting lock', error);
            this._setLockIndicator(!state);
        });
    }

    _openSetupDialog() {
        const STYLE_TITLE = 'font-weight: bold; font-size: 1.1em; margin-bottom: 8px;';
        const STYLE_TEXT = 'margin-bottom: 4px;';
        const STYLE_CODE_BOX = 'background-color: rgba(0,0,0,0.15); border-radius: 4px; padding: 6px 8px; margin: 2px 0;';
        const STYLE_CODE_LABEL = 'font-family: monospace;';

        const dialog = new ModalDialog.ModalDialog({ destroyOnClose: true, styleClass: 'my-dialog' });
        dialog.contentLayout.style = 'min-width: 700px;';

        const box = new St.BoxLayout({ vertical: true, x_expand: true, style: 'spacing: 2px;' });

        const addLabel = (text, style) => {
            const label = new St.Label({ text, x_align: Clutter.ActorAlign.START, style });
            label.clutter_text.line_wrap = true;
            box.add_child(label);
        };

        const addCode = text => {
            const codeBox = new St.BoxLayout({ vertical: false, x_expand: true, style: STYLE_CODE_BOX });
            const label = new St.Label({ text, x_align: Clutter.ActorAlign.START, x_expand: true, style: STYLE_CODE_LABEL });
            label.clutter_text.line_wrap = true;
            label.clutter_text.selectable = true;
            codeBox.add_child(label);
            box.add_child(codeBox);
        };

        addLabel(_('This extension needs root access to control the CPU energy-performance-preference.'), STYLE_TITLE);
        addLabel(_('Run the install script once:'), STYLE_TEXT);
        addCode('bash $HOME/.local/share/gnome-shell/extensions/epp-modes@shell-extensions.github.io/install.sh');
        addLabel(_('Then restart GNOME Shell or disable/enable the extension.'), STYLE_TEXT);

        dialog.contentLayout.add_child(box);
        dialog.addButton({ label: _('Close'), action: () => dialog.close(global.get_current_time()) });
        dialog.open(global.get_current_time());
    }

    destroy() {
        if (this._refreshSourceId) {
            GLib.Source.remove(this._refreshSourceId);
            this._refreshSourceId = 0;
        }
        if (this._clickedId) {
            this.disconnect(this._clickedId);
            this._clickedId = 0;
        }
        if (this._menuOpenId) {
            this.menu.disconnect(this._menuOpenId);
            this._menuOpenId = 0;
        }
        if (this._monitor) {
            if (this._monitorChangedId)
                this._monitor.disconnect(this._monitorChangedId);
            this._monitor.cancel();
            this._monitor = null;
            this._monitorChangedId = 0;
        }
        super.destroy();
    }
});

const EppIndicator = GObject.registerClass(
class EppIndicator extends QuickSettings.SystemIndicator {
    _init() {
        super._init();
        this._indicator = this._addIndicator();
        this._indicator.icon_name = 'power-profile-balanced-symbolic';
        this.quickSettingsItems.push(new EppMenu(this._indicator));
    }

    moveToDefaultPosition() {
        // Delay until after the mainloop turn in which addExternalIndicator
        // ran, so every extension's toggle is already in the grid — same
        // technique as hotspot@yurij.de's own moveToDefaultPosition().
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => this._reorderToggle());
    }

    _reorderToggle() {
        const grid = Main.panel?.statusArea?.quickSettings?.menu?._grid;
        if (!grid?.get_children)
            return GLib.SOURCE_REMOVE;

        const toggles = grid.get_children().filter(child =>
            child instanceof QuickSettings.QuickToggle ||
            child instanceof QuickSettings.QuickMenuToggle);

        const ourToggle = this.quickSettingsItems[0];
        const currentIndex = toggles.indexOf(ourToggle);
        if (currentIndex === -1)
            return GLib.SOURCE_REMOVE;

        const desired = Math.min(Math.max(0, EPP_POSITION), toggles.length - 1);
        if (desired !== currentIndex) {
            toggles.splice(currentIndex, 1);
            toggles.splice(desired, 0, ourToggle);

            let last = null;
            for (const item of toggles) {
                grid.set_child_above_sibling(item, last);
                last = item;
            }
        }

        return GLib.SOURCE_REMOVE;
    }
});

export default class EppModesExtension extends Extension {
    enable() {
        this._indicator = new EppIndicator();
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
        this._indicator.moveToDefaultPosition();

        // Best-effort: hide GNOME's own power-profile toggle so the two
        // controllers don't visually compete. Never a hard requirement —
        // _powerProfiles is an undocumented internal, confirmed present in
        // Shell 46 (ui/panel.js) but not guaranteed to exist in later versions.
        //
        // A plain one-shot `visible = false` doesn't stick: the native
        // toggle's own _sync() unconditionally does
        // `this.visible = this._proxy.g_name_owner !== null`, and it re-runs
        // on every 'g-properties-changed' from power-profiles-daemon — which
        // fires as soon as its own platform_profile driver notices our
        // helper's direct sysfs writes drift the value. So instead of
        // fighting that repeatedly, wrap _sync() itself via InjectionManager
        // (the same mechanism Shell uses internally) to re-assert
        // visible = false right after every native sync.
        try {
            const native = Main.panel.statusArea.quickSettings._powerProfiles;
            if (native) {
                this._nativeToggle = native;
                const [toggle] = native.quickSettingsItems;
                if (toggle) {
                    this._injectionManager = new InjectionManager();
                    this._injectionManager.overrideMethod(
                        toggle.constructor.prototype, '_sync', originalSync => {
                            return function () {
                                originalSync.call(this);
                                this.visible = false;
                            };
                        });
                }
                native.visible = false;
                for (const item of native.quickSettingsItems)
                    item.visible = false;
            }
        } catch (error) {
            console.error('EPP Power Modes: could not hide native power profile toggle', error);
        }
    }

    disable() {
        if (this._injectionManager) {
            this._injectionManager.clear();
            this._injectionManager = null;
        }

        if (this._nativeToggle) {
            this._nativeToggle.visible = true;
            for (const item of this._nativeToggle.quickSettingsItems)
                item.visible = true;
            this._nativeToggle = null;
        }

        if (this._indicator) {
            this._indicator.quickSettingsItems.forEach(item => item.destroy());
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
