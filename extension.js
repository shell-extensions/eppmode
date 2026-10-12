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

const HELPER_PATH = '/usr/local/bin/eppmode-helper';
const STATE_DIR_PATH = '/var/lib/eppmode';
const STATE_FILE_NAME = 'state';
const STATE_FILE_PATH = `${STATE_DIR_PATH}/${STATE_FILE_NAME}`;
const CPU_SYSFS_PATH = '/sys/devices/system/cpu';
const EPP_FILE_NAME = 'energy_performance_preference';
const HARDWARE_POLL_SECONDS = 5;
const TEXT_DECODER = new TextDecoder('utf-8');

// Rolling click-cycle window: each click resets it. Inside the window we keep
// stepping in the same direction; outside it, the next click jumps back to
// whatever was active before the last change (see _cycleMode()).
const CYCLE_WINDOW_US = 10_000_000;
const DIRECTION_TOWARD_SAVER = -1;
const DIRECTION_TOWARD_PERFORMANCE = 1;

// Row directly below hotspot's own fixed TARGET_POSITION=4 (hotspot@yurij.de),
// left column of a 2-column grid (even index). hotspotIndex+1 (odd) landed in
// hotspot's own row instead — same row, not the next one. loadshed positions
// itself independently to 7 (right column of this same row).
const EPP_POSITION = 6;
// Immediately before EPP_POSITION in reading order (one row up, beside
// hotspot). Bluetooth is a native Shell toggle, not an extension — it has no
// way to pin its own position, so we place it here as a side effect of our
// own reorder instead of leaving it to drift wherever hotspot/eppmode/
// loadshed's independent absolute-index reorders happen to push it.
const BLUETOOTH_POSITION = 5;

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

const MODE_IDS = MODES.map(mode => mode.id);

const EPP_TO_MODE = new Map([
    ['power', 'power-saver'],
    ['balance_power', 'balanced-powersave'],
    ['balance_performance', 'balanced-performance'],
    ['performance', 'performance'],
]);

const HARDWARE_STATUS_PRESENTATION = {
    mixed: {
        icon: 'dialog-warning-symbolic',
        tileLabel: () => pgettext('hardware status', 'Mixed'),
    },
    unknown: {
        icon: 'dialog-question-symbolic',
        tileLabel: () => pgettext('hardware status', 'Unknown'),
    },
};

function detectHardwareMode(eppValues) {
    if (eppValues.length === 0)
        return 'unknown';

    const uniqueEppValues = new Set(eppValues);
    if (uniqueEppValues.size !== 1)
        return 'mixed';

    const [epp] = uniqueEppValues;
    return EPP_TO_MODE.get(epp) ?? 'unknown';
}

// The platform_profile write for the currently applied mode hasn't been
// confirmed by the hardware yet (tools/eppmode-helper: PLATFORM_PENDING).
// EPP and power-profiles-daemon are already correct in that case — this is
// informational, not an error, and the periodic reassert keeps retrying it
// in the background.
function isPlatformPending(state) {
    return Boolean(state?.PLATFORM_PENDING);
}

function isUnexpectedUnlock(previousLockState, currentLockState, pendingLockState) {
    return previousLockState === true &&
        currentLockState === false &&
        pendingLockState === null;
}

// Pure decision function behind the tile's click-cycle. Given where we are
// now (currentId), what was active immediately before that (previousId), the
// cycle direction carried over from the last click, and whether we're still
// inside the 10s rolling window since the last click, decides the next mode
// and the direction to carry forward.
//
// Contract for the caller (see _cycleMode()):
// - modeIds is MODE_IDS, in fixed on-screen order (power-saver first,
//   performance last) — the two ends of this array are where the ping-pong
//   direction reversal happens.
// - currentId may be a mode id, or something not in modeIds at all (the tile
//   also displays synthetic hardware states 'mixed'/'unknown' — see
//   detectHardwareMode() above). Recover from that by treating it like "no
//   current mode": land on modeIds[0] and resume stepping upward from there.
// - previousId is whatever _setAppliedMode() recorded as the mode active
//   right before the current one (null if there isn't one, e.g. fresh
//   after login, or if it no longer names a real mode).
// - inWindow === false means: this is the "first click" of a new sequence.
//   If previousId is a valid, different mode, jump back to it — mirroring
//   GNOME's own PowerProfilesToggle — and derive the new direction from
//   which way that jump went. Otherwise (no usable previousId) fall back to
//   a single step in the carried-over direction.
// - inWindow === true means: keep stepping in `direction`. Falling off
//   either end of modeIds reverses direction (ping-pong) instead of
//   wrapping around.
//
function computeCycleTarget(modeIds, { currentId, previousId, direction, inWindow }) {
    if (modeIds.length < 2)
        return { targetId: currentId, direction };

    const currentIndex = modeIds.indexOf(currentId);
    if (currentIndex === -1)
        return { targetId: modeIds[0], direction: DIRECTION_TOWARD_PERFORMANCE };

    if (!inWindow) {
        const previousIndex = modeIds.indexOf(previousId);
        if (previousIndex !== -1 && previousIndex !== currentIndex) {
            return {
                targetId: modeIds[previousIndex],
                direction: previousIndex < currentIndex
                    ? DIRECTION_TOWARD_SAVER
                    : DIRECTION_TOWARD_PERFORMANCE,
            };
        }
    }

    const steppedIndex = currentIndex + direction;
    if (steppedIndex < 0 || steppedIndex >= modeIds.length) {
        const reversed = -direction;
        return { targetId: modeIds[currentIndex + reversed], direction: reversed };
    }
    return { targetId: modeIds[steppedIndex], direction };
}

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

const PersistentPopupSwitchMenuItem = GObject.registerClass(
class PersistentPopupSwitchMenuItem extends PopupMenu.PopupSwitchMenuItem {
    activate(_event) {
        this.toggle();
    }
});

const EppMenu = GObject.registerClass(
class EppMenu extends QuickSettings.QuickMenuToggle {
    _init(indicator) {
        super._init({
            title: _('Power'),
            iconName: 'power-profile-balanced-symbolic',
        });

        this._indicator = indicator;
        this.menu.setHeader('power-profile-balanced-symbolic', 'EPP Power Modes');

        this._platformPendingItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        const pendingBox = new St.BoxLayout({ vertical: false, style_class: 'popup-menu-item-content' });
        const pendingIcon = new St.Icon({ icon_name: 'emblem-synchronizing-symbolic', style_class: 'popup-menu-icon' });
        pendingBox.add_child(pendingIcon);
        const pendingLabel = new St.Label({
            text: _('Platform profile pending'),
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        });
        pendingBox.add_child(pendingLabel);
        this._platformPendingItem.actor.add_child(pendingBox);
        this._platformPendingItem.visible = false;
        this.menu.addMenuItem(this._platformPendingItem);

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
            menuItem.connect('activate', () => this._selectModeFromMenu(mode.id));
            modesSection.addMenuItem(menuItem);
            this._modeItems.set(mode.id, menuItem);
        }
        this.menu.addMenuItem(modesSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._lockItem = new PersistentPopupSwitchMenuItem(_('Lock'), false);
        this._lockChangedId = this._lockItem.connect('toggled', (item, state) => this._setLock(state));
        this.menu.addMenuItem(this._lockItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addSettingsAction(_('Power Settings'), 'gnome-power-panel.desktop');

        this._busy = false;
        this._pendingLockState = null;
        this._knownLockState = undefined;
        this._monitor = null;
        this._monitorChangedId = 0;
        this._refreshSourceId = 0;
        this._appliedId = undefined;
        this._previousId = null;
        this._cycleDirection = DIRECTION_TOWARD_SAVER;
        this._cycleTargetId = null;
        this._lastClickTimeUs = 0;
        this._queuedModeId = null;
        this._inFlightModeId = null;

        this._clickedId = this.connect('clicked', () => this._cycleMode());
        this._menuOpenId = this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen)
                this._refreshFromSystem();
        });

        this._startStateMonitor();
        this._startHardwarePoll();
        this._refreshFromSystem();
    }

    _runCommand(command) {
        return new Promise((resolve, reject) => {
            let subprocess;
            try {
                subprocess = Gio.Subprocess.new(
                    command,
                    Gio.SubprocessFlags.STDOUT_SILENCE |
                    Gio.SubprocessFlags.STDERR_PIPE
                );
            } catch (error) {
                reject(error);
                return;
            }

            subprocess.communicate_utf8_async(null, null, (source, result) => {
                try {
                    const [, , stderr] = source.communicate_utf8_finish(result);
                    if (source.get_successful()) {
                        resolve();
                    } else {
                        const status = source.get_if_exited()
                            ? source.get_exit_status()
                            : `signal ${source.get_term_sig()}`;
                        const error = new Error(
                            `Command failed with ${status}\n${stderr ?? ''}`);
                        error.stderrOutput = stderr ?? '';
                        reject(error);
                    }
                } catch (error) {
                    try {
                        error.stderrOutput ??= '';
                    } catch {
                        // Some Gio errors are not extensible JavaScript objects.
                    }
                    reject(error);
                }
            });
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
            // tools/eppmode-helper), replacing the inode at STATE_FILE_PATH
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
            this._refreshFromSystem();
            return GLib.SOURCE_REMOVE;
        });
    }

    _readTextFile(path) {
        try {
            const [ok, contents] = GLib.file_get_contents(path);
            if (!ok || contents === null)
                return null;
            return TEXT_DECODER.decode(contents).trim();
        } catch (error) {
            console.error(`EPP Power Modes: error reading ${path}`, error);
            return null;
        }
    }

    _readHardwareMode() {
        const eppValues = [];
        let enumerator = null;

        try {
            const cpuDirectory = Gio.File.new_for_path(CPU_SYSFS_PATH);
            enumerator = cpuDirectory.enumerate_children(
                'standard::name',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                null);

            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                const cpuName = info.get_name();
                if (!/^cpu[0-9]+$/.test(cpuName))
                    continue;

                const eppPath = `${CPU_SYSFS_PATH}/${cpuName}/cpufreq/${EPP_FILE_NAME}`;
                if (!GLib.file_test(eppPath, GLib.FileTest.EXISTS))
                    continue;

                const epp = this._readTextFile(eppPath);
                if (!epp)
                    return 'unknown';
                eppValues.push(epp);
            }
        } catch (error) {
            console.error('EPP Power Modes: error enumerating CPU EPP state', error);
            return 'unknown';
        } finally {
            try {
                enumerator?.close(null);
            } catch (error) {
                console.error('EPP Power Modes: error closing CPU EPP enumerator', error);
            }
        }

        return detectHardwareMode(eppValues);
    }

    _startHardwarePoll() {
        this._hardwarePollSourceId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            HARDWARE_POLL_SECONDS,
            () => {
                if (!this._busy)
                    this._refreshFromSystem();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _refreshFromSystem() {
        const state = this._readStateFile();
        const locked = state?.LOCK === '1';
        if (this._pendingLockState === null) {
            if (isUnexpectedUnlock(this._knownLockState, locked, this._pendingLockState)) {
                Main.notify(
                    _('Lock disabled'),
                    _('The lock was disabled because the power mode could not be enforced.'));
            }
            this._knownLockState = locked;
            this._setLockIndicator(locked);
        }
        this._setPlatformPending(isPlatformPending(state));
        // EPP values are written CPU by CPU, followed by platform_profile.
        // Avoid exposing that brief intermediate combination as "Mixed";
        // _applyMode() reconciles from hardware after the helper exits.
        if (this._busy)
            return;
        this._setAppliedMode(this._readHardwareMode());
    }

    _setPlatformPending(pending) {
        this._platformPendingItem.visible = pending;
    }

    // The tile and the panel icon always show the applied mode. An
    // unconfirmed platform_profile (tools/eppmode-helper: PLATFORM_PENDING) is
    // normal on hardware that rejects a tier — e.g. DYTC refusing
    // "performance" — and used to replace the mode icon with a "syncing"
    // emblem for as long as it lasted, which made the active mode
    // unrecognisable. The pending state is only shown in the menu's
    // "Platform profile pending" row; the click cycle in _cycleMode()
    // ignores it, since EPP and power-profiles-daemon are already correct.
    _updateIcon(icon) {
        this.iconName = icon;
        this._indicator.icon_name = icon;
    }

    _setLockIndicator(locked) {
        this._lockItem.block_signal_handler(this._lockChangedId);
        this._lockItem.setToggleState(locked);
        this._lockItem.unblock_signal_handler(this._lockChangedId);
    }

    _setBusy(busy) {
        this._busy = busy;
        for (const item of this._modeItems.values())
            item.setSensitive(!busy);
        this._lockItem.setSensitive(!busy);
    }

    _setAppliedMode(id) {
        const mode = MODES.find(m => m.id === id);
        const presentation = mode ??
            HARDWARE_STATUS_PRESENTATION[id] ??
            HARDWARE_STATUS_PRESENTATION.unknown;
        const appliedId = mode
            ? mode.id
            : (Object.hasOwn(HARDWARE_STATUS_PRESENTATION, id) ? id : 'unknown');

        // Track what was active immediately before this change, so the next
        // "first click" of a new cycle sequence (see _cycleMode()) knows
        // what to jump back to. Guarded on `!== undefined` so the very first
        // sync at startup never records a bogus "previous" state.
        const changed = this._appliedId !== undefined && this._appliedId !== appliedId;
        if (changed)
            this._previousId = this._appliedId;
        this._appliedId = appliedId;

        for (const [modeId, item] of this._modeItems)
            item._tick.visible = modeId === appliedId;
        this._updateIcon(presentation.icon);
        this.subtitle = presentation.tileLabel();
        this.menu.setHeader(presentation.icon, 'EPP Power Modes');
        // Mirror GNOME's own PowerProfilesToggle: highlighted only away from
        // the balanced middle, i.e. for the two non-balanced extremes.
        this.checked = appliedId === 'power-saver' || appliedId === 'performance';
    }

    // Click on the tile body. Within a 10s rolling window since the last
    // click, keep stepping in the same direction, reversing at either end
    // (ping-pong) instead of wrapping around. The first click of a new
    // sequence instead jumps back to whatever was active before the current
    // mode — mirroring GNOME's own PowerProfilesToggle — and that jump's
    // direction becomes the direction for any further clicks within the
    // window. See computeCycleTarget() for the actual decision.
    _cycleMode() {
        const now = GLib.get_monotonic_time();
        const inWindow = this._lastClickTimeUs !== 0 &&
            now - this._lastClickTimeUs < CYCLE_WINDOW_US;
        this._lastClickTimeUs = now;

        // A mode that is still being applied (from the menu or an earlier
        // click) is the effective current state: _appliedId/_previousId only
        // catch up once the helper has finished, and the mode it replaces is
        // then the one to jump back to.
        const pendingId = this._queuedModeId ?? this._inFlightModeId;

        // Inside the window, count from the last click's target, not from
        // hardware: a helper run may still be in flight, and fast clicking
        // shouldn't get stuck on a stale sysfs read.
        const currentId = inWindow && this._cycleTargetId !== null
            ? this._cycleTargetId
            : pendingId ?? this._appliedId;

        const { targetId, direction } = computeCycleTarget(MODE_IDS, {
            currentId,
            previousId: pendingId !== null ? this._appliedId : this._previousId,
            direction: this._cycleDirection,
            inWindow,
        });

        this._cycleDirection = direction;
        this._cycleTargetId = targetId;
        this._applyMode(targetId);
    }

    // A mode picked from the menu resets the cycle: the next tile click
    // should again act like the "first click" of a new sequence (jump back
    // to whatever was active before), even if a click happened moments ago.
    _selectModeFromMenu(id) {
        this._lastClickTimeUs = 0;
        this._cycleTargetId = null;
        this._applyMode(id);
    }

    _applyMode(id) {
        if (this._busy) {
            // Only the newest target matters: applying intermediate steps
            // would just burn platform_profile writes against the helper's
            // DYTC cooldown for states we're about to leave again.
            this._queuedModeId = id;
            return;
        }
        this._setBusy(true);
        this._inFlightModeId = id;

        this._runHelperCommand(['set', id]).then(() => {
            this._inFlightModeId = null;
            this._setBusy(false);
            if (!this._runQueuedMode())
                this._refreshFromSystem();
        }).catch(error => {
            this._inFlightModeId = null;
            this._setBusy(false);
            if (!error?.handled)
                Main.notify(_('Error'), _('Could not apply the power mode.'));
            console.error('EPP Power Modes: error applying mode', error);
            // A queued mode is the user's latest intent, so try it instead of
            // silently dropping it. A handled error (e.g. the setup dialog was
            // opened) means the helper isn't usable: don't retry against it.
            if (error?.handled)
                this._queuedModeId = null;
            if (!this._runQueuedMode())
                this._refreshFromSystem();
        });
    }

    _runQueuedMode() {
        if (this._queuedModeId === null)
            return false;
        const queued = this._queuedModeId;
        this._queuedModeId = null;
        this._applyMode(queued);
        return true;
    }

    _setLock(state) {
        if (this._busy) {
            this._setLockIndicator(this._knownLockState ?? !state);
            return;
        }

        this._pendingLockState = state;
        this._setBusy(true);
        this._runHelperCommand([state ? 'lock' : 'unlock']).then(() => {
            const wasManualUnlock = this._pendingLockState === false;
            this._pendingLockState = null;
            this._setBusy(false);
            if (wasManualUnlock)
                this._knownLockState = false;
            this._refreshFromSystem();
        }).catch(error => {
            this._pendingLockState = null;
            this._setBusy(false);
            if (!error?.handled)
                Main.notify(_('Error'), _('Could not change the lock state.'));
            console.error('EPP Power Modes: error setting lock', error);
            this._refreshFromSystem();
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
        addCode('bash $HOME/.local/share/gnome-shell/extensions/eppmode@yurij.de/install.sh');
        addLabel(_('Then restart GNOME Shell or disable/enable the extension.'), STYLE_TEXT);

        dialog.contentLayout.add_child(box);
        dialog.addButton({ label: _('Close'), action: () => dialog.close(global.get_current_time()) });
        dialog.open(global.get_current_time());
    }

    destroy() {
        // Prevents a late _runHelperCommand() promise callback from starting
        // another helper run after this menu item is gone.
        this._queuedModeId = null;
        if (this._refreshSourceId) {
            GLib.Source.remove(this._refreshSourceId);
            this._refreshSourceId = 0;
        }
        if (this._hardwarePollSourceId) {
            GLib.Source.remove(this._hardwarePollSourceId);
            this._hardwarePollSourceId = 0;
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

    // Same shape as _powerProfiles (both are SystemIndicator-derived native
    // toggles, guarded by Config.HAVE_BLUETOOTH in ui/panel.js) — best-effort,
    // wrapped in try/catch, may legitimately be absent on Bluetooth-less
    // hardware.
    _findBluetoothToggle() {
        try {
            return Main.panel?.statusArea?.quickSettings?._bluetooth?.quickSettingsItems?.[0] ?? null;
        } catch (error) {
            console.error('EPP Power Modes: could not locate native Bluetooth toggle for positioning', error);
            return null;
        }
    }

    _reorderToggle() {
        const grid = Main.panel?.statusArea?.quickSettings?.menu?._grid;
        if (!grid?.get_children)
            return GLib.SOURCE_REMOVE;

        const toggles = grid.get_children().filter(child =>
            child instanceof QuickSettings.QuickToggle ||
            child instanceof QuickSettings.QuickMenuToggle);

        const ourToggle = this.quickSettingsItems[0];
        if (toggles.indexOf(ourToggle) === -1)
            return GLib.SOURCE_REMOVE;

        const bluetoothToggle = this._findBluetoothToggle();

        // Bluetooth is native, not an extension - it can't pin its own
        // position, so we place it as a side effect of our own reorder:
        // pull both out, reinsert together right before us.
        const rest = toggles.filter(t => t !== ourToggle && t !== bluetoothToggle);
        const insertAt = Math.min(
            Math.max(0, bluetoothToggle ? BLUETOOTH_POSITION : EPP_POSITION),
            rest.length);

        const newOrder = [
            ...rest.slice(0, insertAt),
            ...(bluetoothToggle ? [bluetoothToggle] : []),
            ourToggle,
            ...rest.slice(insertAt),
        ];

        let last = null;
        for (const item of newOrder) {
            grid.set_child_above_sibling(item, last);
            last = item;
        }

        return GLib.SOURCE_REMOVE;
    }
});

export default class EppModesExtension extends Extension {
    enable() {
        this._indicator = new EppIndicator();
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
        this._indicator.moveToDefaultPosition();

        this._nativeIndicatorVisibility = undefined;
        this._nativeItemVisibility = null;
        this._nativePowerProfileItem = null;

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
        //
        // The panel icon needs the same treatment, one level up: the native
        // Indicator binds its inner icon's `visible` to the toggle's `checked`,
        // and SystemIndicator._syncIndicatorsVisible() then sets the whole
        // indicator box visible again as soon as any profile other than
        // "balanced" is active (power-saver, performance). Without this
        // override the native profile icon shows up next to ours in exactly
        // those modes — and shows power-profiles-daemon's profile, not ours.
        // Overridden on the instance, since the method lives on the shared
        // SystemIndicator prototype that every other indicator uses too.
        try {
            const native = Main.panel.statusArea.quickSettings._powerProfiles;
            if (native) {
                this._nativeToggle = native;
                this._nativeIndicatorVisibility = native.visible;
                this._nativeItemVisibility = new Map(
                    native.quickSettingsItems.map(item => [item, item.visible]));
                this._injectionManager = new InjectionManager();
                const [toggle] = native.quickSettingsItems;
                if (toggle) {
                    this._nativePowerProfileItem = toggle;
                    this._injectionManager.overrideMethod(
                        toggle.constructor.prototype, '_sync', originalSync => {
                            return function () {
                                originalSync.call(this);
                                this.visible = false;
                            };
                        });
                }
                this._injectionManager.overrideMethod(
                    native, '_syncIndicatorsVisible', originalSync => {
                        return function () {
                            originalSync.call(this);
                            this.visible = false;
                        };
                    });
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
            if (this._nativeIndicatorVisibility !== undefined)
                this._nativeToggle.visible = this._nativeIndicatorVisibility;
            for (const item of this._nativeToggle.quickSettingsItems) {
                if (this._nativeItemVisibility?.has(item))
                    item.visible = this._nativeItemVisibility.get(item);
            }
            try {
                this._nativePowerProfileItem?._sync();
                this._nativeToggle._syncIndicatorsVisible();
            } catch (error) {
                console.error('EPP Power Modes: could not resync native power profile toggle', error);
            }
            this._nativeToggle = null;
        }
        this._nativeIndicatorVisibility = undefined;
        this._nativeItemVisibility = null;
        this._nativePowerProfileItem = null;

        if (this._indicator) {
            this._indicator.quickSettingsItems.forEach(item => item.destroy());
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
