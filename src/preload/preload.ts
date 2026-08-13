import { contextBridge, ipcRenderer } from 'electron';

import {
  APP_INFO_CHANNEL,
  RENDERER_READY_CHANNEL,
  appInfoSchema,
  type MentalLegosDesktopApi,
} from '../shared/contracts';

const desktopApi: MentalLegosDesktopApi = Object.freeze({
  async getAppInfo() {
    const value: unknown = await ipcRenderer.invoke(APP_INFO_CHANNEL);
    return appInfoSchema.parse(value);
  },
  async reportReady() {
    await ipcRenderer.invoke(RENDERER_READY_CHANNEL);
  },
});

contextBridge.exposeInMainWorld('mentalLegos', desktopApi);
