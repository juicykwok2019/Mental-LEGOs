import { describe, expect, it } from 'vitest';

import {
  isPermittedRendererUrl,
  secureWebPreferences,
} from '../../src/main/security';
import { resolveRendererAssetPath } from '../../src/main/renderer-protocol';

describe('Electron renderer security baseline', () => {
  it('keeps Node.js out of the renderer and enables isolation', () => {
    expect(secureWebPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    });
  });

  it('only permits the configured development origin', () => {
    const devServer = 'http://localhost:5173';

    expect(isPermittedRendererUrl('http://localhost:5173/app', devServer))
      .toBe(true);
    expect(isPermittedRendererUrl('http://127.0.0.1:5173/app', devServer))
      .toBe(false);
    expect(isPermittedRendererUrl('https://example.com', devServer))
      .toBe(false);
  });

  it('only permits the packaged renderer protocol and host', () => {
    expect(isPermittedRendererUrl('mental-legos://app/index.html')).toBe(true);
    expect(isPermittedRendererUrl('mental-legos://other/index.html')).toBe(false);
    expect(isPermittedRendererUrl('file:///app/index.html')).toBe(false);
    expect(isPermittedRendererUrl('https://example.com')).toBe(false);
    expect(isPermittedRendererUrl('not a url')).toBe(false);
  });

  it('confines packaged protocol assets to the renderer root', () => {
    const rendererRoot = 'C:\\app\\renderer';

    expect(resolveRendererAssetPath(
      'mental-legos://app/assets/main.js',
      rendererRoot,
    )).toBe('C:\\app\\renderer\\assets\\main.js');
    expect(resolveRendererAssetPath(
      'mental-legos://app/%2e%2e%2fsecret.txt',
      rendererRoot,
    )).toBeNull();
    expect(resolveRendererAssetPath(
      'mental-legos://other/assets/main.js',
      rendererRoot,
    )).toBeNull();
  });
});
