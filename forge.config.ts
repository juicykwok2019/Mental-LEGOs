import path from 'node:path';

import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const config: ForgeConfig = {
  packagerConfig: {
    // 应用图标：可执行文件、任务栏、以及安装时建的桌面/开始菜单快捷方式都用它。
    // 由 scripts/make-logo.py 生成（一次性资产，不参与构建），七个尺寸各自
    // 原生绘制而非从大图缩。
    icon: path.resolve(__dirname, 'assets/icon'),
    asar: {
      unpack: '**/*.{node,dll}',
    },
    ignore(filePath) {
      if (!filePath) return false;
      if (filePath === '/node_modules') return false;
      const packagedPaths = [
        '/.vite',
        '/node_modules/sherpa-onnx-node',
        '/node_modules/sherpa-onnx-win-x64',
      ];
      return !packagedPaths.some((candidate) => (
        filePath === candidate || filePath.startsWith(`${candidate}/`)
      ));
    },
    extraResource: [
      'resources/capability-bundle',
      'resources/agent-runtime-manifest.json',
      'resources/asr-models',
      'resources/bash-runtime',
      'resources/licenses',
      'node_modules/pdfjs-dist/cmaps',
      'node_modules/pdfjs-dist/standard_fonts',
      'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe',
      'resources/windows-sandbox/MentalLegos.SandboxLauncher.exe',
      'resources/windows-sandbox/MentalLegos.CredentialVault.exe',
      'resources/windows-sandbox/MentalLegos.BashProxy.exe',
      'resources/windows-sandbox/MentalLegos.ProviderProxy.exe',
    ],
  },
  rebuildConfig: {},
  makers: [
    // Squirrel 的安装窗口只有这一张图，没有文字区域也没有路径选择——它固定
    // 装到 %LOCALAPPDATA%，那是它免管理员、能自动更新的前提。所以"装到哪"
    // 只能写在图里。图由 scripts/make-installer-gif.py 生成（一次性资产，
    // 不参与构建）。
    new MakerSquirrel({
      loadingGif: path.resolve(__dirname, 'assets/installer-loading.gif'),
      // 开始菜单里那层文件夹叫 Programs\<authors>\。package.json 的 author 是
      // "Mental LEGOs Contributors"（作为包元数据没问题），但用户在开始菜单里
      // 该看到的是产品名。
      authors: 'Mental LEGOs',
    }),
    new MakerZIP({}, ['win32']),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
        {
          entry: 'src/agent/worker.ts',
          config: 'vite.agent.config.ts',
          target: 'main',
        },
        {
          entry: 'src/asr/worker.ts',
          config: 'vite.asr.config.ts',
          target: 'main',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
      [FuseV1Options.WasmTrapHandlers]: true,
    }),
  ],
};

export default config;
