import { describe, expect, it } from 'vitest';

import { resolveSquirrelAction } from '../../src/main/windows-installer';

const EXE = 'C:\\Users\\me\\AppData\\Local\\MentalLEGOs\\app-0.2.1\\Mental LEGOs.exe';
const UPDATE = 'C:\\Users\\me\\AppData\\Local\\MentalLEGOs\\Update.exe';

describe('Squirrel installer lifecycle', () => {
  it('creates shortcuts on install and update', () => {
    for (const event of ['--squirrel-install', '--squirrel-updated']) {
      const action = resolveSquirrelAction([EXE, event, '0.2.1'], EXE, 'win32');
      expect(action?.event).toBe(event);
      expect(action?.updateExe).toBe(UPDATE);
      expect(action?.updateArgs).toEqual(['--createShortcut=Mental LEGOs.exe']);
    }
  });

  it('removes shortcuts on uninstall', () => {
    const action = resolveSquirrelAction([EXE, '--squirrel-uninstall', '0.2.1'], EXE, 'win32');
    expect(action?.updateArgs).toEqual(['--removeShortcut=Mental LEGOs.exe']);
  });

  it('recognises obsolete and unknown squirrel events without touching shortcuts', () => {
    for (const event of ['--squirrel-obsolete', '--squirrel-something-new']) {
      const action = resolveSquirrelAction([EXE, event], EXE, 'win32');
      // 认出来才会退出；updateArgs 为 null 表示不动快捷方式。
      expect(action).not.toBeNull();
      expect(action?.updateArgs).toBeNull();
    }
  });

  it('treats a normal launch as a normal launch', () => {
    expect(resolveSquirrelAction([EXE], EXE, 'win32')).toBeNull();
    expect(resolveSquirrelAction([EXE, '--enable-logging'], EXE, 'win32')).toBeNull();
    // 用户自己的文件路径里出现 squirrel 字样不该被误认。
    expect(resolveSquirrelAction([EXE, 'C:\\squirrel-notes.md'], EXE, 'win32')).toBeNull();
  });

  it('never fires off Windows', () => {
    expect(resolveSquirrelAction([EXE, '--squirrel-install'], EXE, 'darwin')).toBeNull();
    expect(resolveSquirrelAction([EXE, '--squirrel-install'], EXE, 'linux')).toBeNull();
  });
});
