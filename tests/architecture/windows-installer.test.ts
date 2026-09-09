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

  it('quits quietly on obsolete without touching shortcuts', () => {
    const action = resolveSquirrelAction([EXE, '--squirrel-obsolete', '0.2.0'], EXE, 'win32');
    // 认出来才会退出；updateArgs 为 null 表示不动快捷方式。
    expect(action).not.toBeNull();
    expect(action?.updateArgs).toBeNull();
  });

  it('lets the first run after install start the app', () => {
    // 装完之后 Squirrel 就是用这个参数启动应用的。按 --squirrel- 前缀一刀切
    // 会把它当成生命周期事件，应用装完即退——安装完打不开就是这么来的。
    expect(resolveSquirrelAction([EXE, '--squirrel-firstrun'], EXE, 'win32')).toBeNull();
  });

  it('treats a normal launch as a normal launch', () => {
    expect(resolveSquirrelAction([EXE], EXE, 'win32')).toBeNull();
    expect(resolveSquirrelAction([EXE, '--enable-logging'], EXE, 'win32')).toBeNull();
    // 未知的 --squirrel-* 事件同样按正常启动处理：宁可多起一个窗口，
    // 也不能让应用打不开。
    expect(resolveSquirrelAction([EXE, '--squirrel-something-new'], EXE, 'win32')).toBeNull();
    // 用户自己的文件路径里出现 squirrel 字样不该被误认。
    expect(resolveSquirrelAction([EXE, 'C:\\squirrel-notes.md'], EXE, 'win32')).toBeNull();
  });

  it('never fires off Windows', () => {
    expect(resolveSquirrelAction([EXE, '--squirrel-install'], EXE, 'darwin')).toBeNull();
    expect(resolveSquirrelAction([EXE, '--squirrel-install'], EXE, 'linux')).toBeNull();
  });
});
