import type { BrowserWindowConstructorOptions } from 'electron';

import { RENDERER_HOST, RENDERER_SCHEME } from './renderer-protocol';

export const secureWebPreferences = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
} satisfies NonNullable<BrowserWindowConstructorOptions['webPreferences']>;

export function isPermittedRendererUrl(
  targetUrl: string,
  developmentServerUrl?: string,
): boolean {
  if (developmentServerUrl) {
    try {
      return new URL(targetUrl).origin === new URL(developmentServerUrl).origin;
    } catch {
      return false;
    }
  }

  try {
    const parsedUrl = new URL(targetUrl);
    return parsedUrl.protocol === `${RENDERER_SCHEME}:`
      && parsedUrl.hostname === RENDERER_HOST;
  } catch {
    return false;
  }
}
