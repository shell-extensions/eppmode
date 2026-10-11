#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const extensionPath = new URL('../extension.js', import.meta.url);
const source = readFileSync(extensionPath, 'utf8');
const start = source.indexOf('const CYCLE_WINDOW_US =');
const end = source.indexOf('function parseStateFile');

assert.notEqual(start, -1, 'hardware detection block start not found');
assert.notEqual(end, -1, 'hardware detection block end not found');
assert.ok(end > start, 'hardware detection block is malformed');

const context = {};
vm.runInNewContext(
    `${source.slice(start, end)}
globalThis.MODE_IDS = MODE_IDS;
globalThis.detectHardwareMode = detectHardwareMode;
globalThis.isUnexpectedUnlock = isUnexpectedUnlock;
globalThis.isPlatformPending = isPlatformPending;
globalThis.computeCycleTarget = computeCycleTarget;`,
    context);

const detect = context.detectHardwareMode;
const cases = [
    [['power'], 'power-saver'],
    [['balance_power'], 'balanced-powersave'],
    [['balance_performance'], 'balanced-performance'],
    [['performance'], 'performance'],
    [['power', 'balance_power'], 'mixed'],
    [['unsupported'], 'unknown'],
    [[], 'unknown'],
];

for (const [eppValues, expected] of cases)
    assert.equal(detect(eppValues), expected);

const unlockCases = [
    [[true, false, null], true],
    [[true, false, false], false],
    [[true, true, null], false],
    [[false, false, null], false],
    [[undefined, false, null], false],
];

for (const [args, expected] of unlockCases)
    assert.equal(context.isUnexpectedUnlock(...args), expected);

const platformPendingCases = [
    [null, false],
    [undefined, false],
    [{}, false],
    [{ PLATFORM_PENDING: '' }, false],
    [{ PLATFORM_PENDING: 'low-power' }, true],
    [{ PLATFORM_PENDING: 'balanced' }, true],
];

for (const [state, expected] of platformPendingCases)
    assert.equal(context.isPlatformPending(state), expected);

const modeIds = context.MODE_IDS;
const SAVER = -1;
const PERFORMANCE = 1;
const cycleCases = [
    // [{ currentId, previousId, direction, inWindow }, { targetId, direction }]
    // First click of a new sequence: jump back to previousId, direction
    // derived from which way that jump went.
    [{ currentId: 'performance', previousId: 'balanced-performance', direction: PERFORMANCE, inWindow: false },
        { targetId: 'balanced-performance', direction: SAVER }],
    [{ currentId: 'power-saver', previousId: 'balanced-powersave', direction: SAVER, inWindow: false },
        { targetId: 'balanced-powersave', direction: PERFORMANCE }],
    // Continuing within the window: one step in the carried direction.
    [{ currentId: 'balanced-performance', previousId: 'performance', direction: SAVER, inWindow: true },
        { targetId: 'balanced-powersave', direction: SAVER }],
    // Ping-pong at either end instead of wrapping around.
    [{ currentId: 'power-saver', previousId: 'balanced-powersave', direction: SAVER, inWindow: true },
        { targetId: 'balanced-powersave', direction: PERFORMANCE }],
    [{ currentId: 'performance', previousId: 'balanced-performance', direction: PERFORMANCE, inWindow: true },
        { targetId: 'balanced-performance', direction: SAVER }],
    // Hardware reports a synthetic status, not a real mode: recover onto
    // modeIds[0] and resume stepping upward.
    [{ currentId: 'mixed', previousId: 'performance', direction: SAVER, inWindow: false },
        { targetId: 'power-saver', direction: PERFORMANCE }],
    [{ currentId: 'unknown', previousId: null, direction: SAVER, inWindow: true },
        { targetId: 'power-saver', direction: PERFORMANCE }],
    // No usable previousId (fresh after login, or previous === current):
    // fall back to a single step in the carried direction.
    [{ currentId: 'balanced-performance', previousId: null, direction: SAVER, inWindow: false },
        { targetId: 'balanced-powersave', direction: SAVER }],
    [{ currentId: 'balanced-performance', previousId: 'balanced-performance', direction: PERFORMANCE, inWindow: false },
        { targetId: 'performance', direction: PERFORMANCE }],
];

// vm.runInNewContext() objects live in a different realm, so their
// Object.prototype differs from ours — compare fields, not deepStrictEqual.
for (const [args, expected] of cycleCases) {
    const result = context.computeCycleTarget(modeIds, args);
    assert.equal(result.targetId, expected.targetId);
    assert.equal(result.direction, expected.direction);
}

console.log(`${cases.length + unlockCases.length + platformPendingCases.length + cycleCases.length} hardware status, lock, and click-cycle tests passed`);
