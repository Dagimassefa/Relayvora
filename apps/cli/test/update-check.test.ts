import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RELAYVORA_VERSION } from '@relayvora/core';
import { describe, expect, it } from 'vitest';
import { checkForUpdate, compareVersions } from '../src/update-check.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'relayvora-update-'));
const DAY = 24 * 60 * 60 * 1000;

describe('compareVersions', () => {
  it('orders releases and pre-releases the way npm does', () => {
    const ordered = ['0.1.0-alpha.0', '0.1.0-alpha.1', '0.1.0-alpha.10', '0.1.0-beta', '0.1.0-beta.2', '0.1.0', '0.1.1', '0.2.0', '1.0.0'];
    for (let i = 1; i < ordered.length; i++) {
      expect(compareVersions(ordered[i]!, ordered[i - 1]!), `${ordered[i]} > ${ordered[i - 1]}`).toBeGreaterThan(0);
      expect(compareVersions(ordered[i - 1]!, ordered[i]!)).toBeLessThan(0);
    }
    expect(compareVersions('0.1.0-alpha.1', '0.1.0-alpha.1')).toBe(0);
  });
});

describe('checkForUpdate', () => {
  it('reports a newer version, and asks the registry at most once a day', async () => {
    const dir = tmp();
    let calls = 0;
    const fetchLatest = async () => (calls++, '99.0.0');
    const now = new Date('2026-11-02T10:00:00Z');
    expect(await checkForUpdate(dir, {}, fetchLatest, now)).toEqual({ current: RELAYVORA_VERSION, latest: '99.0.0' });
    expect(await checkForUpdate(dir, {}, fetchLatest, new Date(now.getTime() + DAY - 1))).toEqual({ current: RELAYVORA_VERSION, latest: '99.0.0' });
    expect(calls).toBe(1);
    await checkForUpdate(dir, {}, fetchLatest, new Date(now.getTime() + DAY));
    expect(calls).toBe(2);
  });

  it('stays quiet when up to date, offline, or turned off', async () => {
    expect(await checkForUpdate(tmp(), {}, async () => RELAYVORA_VERSION)).toBeNull();
    expect(await checkForUpdate(tmp(), {}, async () => '0.0.1')).toBeNull();

    // Offline: no notice, and the failure is cached so the next run does not wait again.
    const offline = tmp();
    let calls = 0;
    const fail = async () => {
      calls++;
      throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org');
    };
    expect(await checkForUpdate(offline, {}, fail)).toBeNull();
    expect(await checkForUpdate(offline, {}, fail)).toBeNull();
    expect(calls).toBe(1);

    let asked = false;
    const spy = async () => ((asked = true), '99.0.0');
    expect(await checkForUpdate(tmp(), { RELAYVORA_NO_UPDATE_CHECK: '1' }, spy)).toBeNull();
    expect(await checkForUpdate(tmp(), { CI: 'true' }, spy)).toBeNull();
    expect(asked).toBe(false);
  });

  it('keeps the last known version when a later check fails', async () => {
    const dir = tmp();
    const now = new Date('2026-11-02T10:00:00Z');
    await checkForUpdate(dir, {}, async () => '99.0.0', now);
    const later = await checkForUpdate(dir, {}, async () => null, new Date(now.getTime() + 2 * DAY));
    expect(later?.latest).toBe('99.0.0');
  });
});
