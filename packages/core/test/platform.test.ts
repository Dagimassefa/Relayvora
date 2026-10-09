import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareVersions } from '../src/version.js';
import { dataDir, detectWsl, findExecutable, isWithin, pathsEqual } from '../src/platform.js';

describe('dataDir', () => {
  it('honours AGENTRELAY_HOME', () => {
    expect(dataDir({ AGENTRELAY_HOME: '/tmp/ar' }, 'linux', '/home/u')).toBe('/tmp/ar');
  });
  it('uses LOCALAPPDATA on Windows', () => {
    expect(dataDir({ LOCALAPPDATA: 'C:\\Users\\Ana Lú\\AppData\\Local' }, 'win32', 'C:\\Users\\Ana Lú')).toBe(
      'C:\\Users\\Ana Lú\\AppData\\Local\\agentrelay',
    );
  });
  it('uses Application Support on macOS', () => {
    expect(dataDir({}, 'darwin', '/Users/u')).toBe('/Users/u/Library/Application Support/agentrelay');
  });
  it('uses XDG_DATA_HOME, then ~/.local/share, on Linux', () => {
    expect(dataDir({ XDG_DATA_HOME: '/data' }, 'linux', '/home/u')).toBe('/data/agentrelay');
    expect(dataDir({}, 'linux', '/home/u')).toBe('/home/u/.local/share/agentrelay');
  });
});

describe('path comparison', () => {
  it('is case-insensitive on Windows and macOS only', () => {
    expect(pathsEqual('C:\\Repo\\App', 'c:\\repo\\app\\', 'win32')).toBe(true);
    expect(pathsEqual('/Users/a/Repo', '/users/a/repo', 'darwin')).toBe(true);
    expect(pathsEqual('/home/a/Repo', '/home/a/repo', 'linux')).toBe(false);
  });
  it('detects containment without prefix false positives', () => {
    expect(isWithin('/work/app', '/work/app/src', 'linux')).toBe(true);
    expect(isWithin('/work/app', '/work/app', 'linux')).toBe(true);
    expect(isWithin('/work/app', '/work/app-other', 'linux')).toBe(false);
    expect(isWithin('C:\\work\\app', 'c:\\WORK\\app\\src', 'win32')).toBe(true);
  });
});

describe('detectWsl', () => {
  it('is false off Linux and true with WSL env vars', () => {
    expect(detectWsl('win32', { WSL_DISTRO_NAME: 'Ubuntu' })).toBe(false);
    expect(detectWsl('linux', { WSL_DISTRO_NAME: 'Ubuntu' })).toBe(true);
  });
});

describe('findExecutable', () => {
  it('finds an executable in a PATH directory containing spaces and Unicode', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar exé '));
    const isWin = process.platform === 'win32';
    const file = path.join(dir, isWin ? 'fake-agent.cmd' : 'fake-agent');
    fs.writeFileSync(file, isWin ? '@echo fake 1.0\r\n' : '#!/bin/sh\necho fake 1.0\n', { mode: 0o755 });
    const env = { PATH: dir, PATHEXT: '.EXE;.CMD' };
    expect(findExecutable('fake-agent', env)?.toLowerCase()).toBe(file.toLowerCase());
    expect(findExecutable('missing-agent', env)).toBeUndefined();
  });
});

describe('compareVersions', () => {
  it('orders semver-ish strings', () => {
    expect(compareVersions('22.13.0', '22.13.0')).toBe(0);
    expect(compareVersions('v22.17.0', '22.13.0')).toBe(1);
    expect(compareVersions('20.11.1', '22.13.0')).toBe(-1);
  });
});
