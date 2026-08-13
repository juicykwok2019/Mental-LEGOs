import { contextBridge, ipcRenderer } from 'electron';

import {
  APP_INFO_CHANNEL,
  AGENT_READINESS_GET_CHANNEL,
  BASH_RUNTIME_INSTALL_CHANNEL,
  PROVIDER_SETUP_CLEAR_CHANNEL,
  PROVIDER_SETUP_GET_CHANNEL,
  PROVIDER_SETUP_SAVE_CHANNEL,
  RENDERER_READY_CHANNEL,
  appInfoSchema,
  agentReadinessStateSchema,
  providerSetupInputSchema,
  providerSetupStateSchema,
  type MentalLegosDesktopApi,
  type ProviderSetupInput,
} from '../shared/contracts';

const desktopApi: MentalLegosDesktopApi = Object.freeze({
  async getAppInfo() {
    const value: unknown = await ipcRenderer.invoke(APP_INFO_CHANNEL);
    return appInfoSchema.parse(value);
  },
  async reportReady() {
    await ipcRenderer.invoke(RENDERER_READY_CHANNEL);
  },
  async getProviderSetup() {
    const value: unknown = await ipcRenderer.invoke(PROVIDER_SETUP_GET_CHANNEL);
    return providerSetupStateSchema.parse(value);
  },
  async saveProviderSetup(input: ProviderSetupInput) {
    const validated = providerSetupInputSchema.parse(input);
    const value: unknown = await ipcRenderer.invoke(
      PROVIDER_SETUP_SAVE_CHANNEL,
      validated,
    );
    return providerSetupStateSchema.parse(value);
  },
  async clearProviderSetup() {
    const value: unknown = await ipcRenderer.invoke(PROVIDER_SETUP_CLEAR_CHANNEL);
    return providerSetupStateSchema.parse(value);
  },
  async getAgentReadiness() {
    const value: unknown = await ipcRenderer.invoke(AGENT_READINESS_GET_CHANNEL);
    return agentReadinessStateSchema.parse(value);
  },
  async installBashRuntime() {
    const value: unknown = await ipcRenderer.invoke(BASH_RUNTIME_INSTALL_CHANNEL);
    return agentReadinessStateSchema.parse(value);
  },
});

contextBridge.exposeInMainWorld('mentalLegos', desktopApi);
