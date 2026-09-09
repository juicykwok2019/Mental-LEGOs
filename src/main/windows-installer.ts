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

  // 只有这四个事件意味着"建完快捷方式就退出"。**不能**按前缀一刀切：装完之后
  // Squirrel 正是用 --squirrel-firstrun 启动应用的，那是一次正常启动；把它当
  // 生命周期事件处理，应用会在装完后自己退出（v0.2.1 打包时踩过）。
  const exeName = path.basename(execPath);
  const shortcutArgs: Record<string, string[] | null> = {
    '--squirrel-install': [`--createShortcut=${exeName}`],
    '--squirrel-updated': [`--createShortcut=${exeName}`],
    '--squirrel-uninstall': [`--removeShortcut=${exeName}`],
    // 旧版本即将被删：安静退出，不碰快捷方式。
    '--squirrel-obsolete': null,
  };
  if (!(event in shortcutArgs)) return null;

  return {
    event,
    updateExe: path.resolve(path.dirname(execPath), '..', 'Update.exe'),
    updateArgs: shortcutArgs[event] ?? null,
  };
}
