#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const extensionPath = new URL('../extension.js', import.meta.url);
const source = readFileSync(extensionPath, 'utf8');
const start = source.indexOf('const EPP_TO_MODE =');
const end = source.indexOf('function parseStateFile');

assert.notEqual(start, -1, 'hardware detection block start not found');
assert.notEqual(end, -1, 'hardware detection block end not found');
assert.ok(end > start, 'hardware detection block is malformed');

const context = {};
vm.runInNewContext(
    `${source.slice(start, end)}
globalThis.detectHardwareMode = detectHardwareMode;`,
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

console.log(`${cases.length} hardware status tests passed`);
