import path from 'node:path';

// Squirrel.Windows 在安装、更新、卸载时都会用一个 --squirrel-* 参数把主程序
// 运行一次。约定是应用认出这个参数、建好（或删掉）快捷方式，然后立刻退出：
// 快捷方式并不是安装器自己创建的，而是应用在这一步调 Update.exe 建的。
//
// 不识别这些参数的应用会走完整启动流程，于是装机时先弹一个产品窗口、被安装器
// 杀掉、装完再弹一个（2026-09-09 v0.2.1 真机安装验收时看到的现象）。

export interface SquirrelAction {
  event: string;
  /** Update.exe 的绝对路径（与主程序同级的上一层目录）。 */
  updateExe: string;
  /** 传给 Update.exe 的参数；null 表示这个事件不需要动快捷方式。 */
  updateArgs: string[] | null;
}

/** 认出 Squirrel 的生命周期事件。返回 null 表示这是一次正常启动。 */
export function resolveSquirrelAction(
  argv: readonly string[],
  execPath: string,
  platform: NodeJS.Platform,
): SquirrelAction | null {
  if (platform !== 'win32') return null;
  const event = argv[1];
  if (event === undefined || !event.startsWith('--squirrel-')) return null;

  const updateExe = path.resolve(path.dirname(execPath), '..', 'Update.exe');
  const exeName = path.basename(execPath);
  // --squirrel-obsolete（旧版本即将被删）和任何未知的 --squirrel-* 事件都只
  // 需要安静退出，不该碰快捷方式。
  const updateArgs = event === '--squirrel-install' || event === '--squirrel-updated'
    ? [`--createShortcut=${exeName}`]
    : event === '--squirrel-uninstall'
      ? [`--removeShortcut=${exeName}`]
      : null;

  return { event, updateExe, updateArgs };
}
