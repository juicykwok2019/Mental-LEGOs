import { contextBridge, ipcRenderer } from 'electron';

import {
  APP_INFO_CHANNEL,
  AGENT_READINESS_GET_CHANNEL,
  BASH_RUNTIME_INSTALL_CHANNEL,
  PROVIDER_SETUP_CLEAR_CHANNEL,
  PROVIDER_CERTIFICATION_CANCEL_CHANNEL,
  PROVIDER_CERTIFICATION_CONFIRM_CHANNEL,
  PROVIDER_CERTIFICATION_START_CHANNEL,
  PROVIDER_SETUP_GET_CHANNEL,
  PROVIDER_SETUP_SAVE_CHANNEL,
  RENDERER_READY_CHANNEL,
  TRAINING_CLOSE_FIRST_CHANNEL,
  TRAINING_CONFIRM_CHANNEL,
  TRAINING_DIAGNOSE_CHANNEL,
  TRAINING_DUE_CHANNEL,
  TRAINING_EXTRACT_CHANNEL,
  TRAINING_HINT_CHANNEL,
  TRAINING_SECOND_CHANNEL,
  TRAINING_START_CHANNEL,
  appInfoSchema,
  agentReadinessStateSchema,
  providerSetupInputSchema,
  providerSetupStateSchema,
  providerCertificationDraftSchema,
  providerCertificationIdSchema,
  providerCertificationResultSchema,
  trainingCloseFirstInputSchema,
  trainingConfirmInputSchema,
  trainingDueListSchema,
  trainingHintLevelSchema,
  trainingSecondInputSchema,
  trainingStartInputSchema,
  trainingTurnStateSchema,
  type MentalLegosDesktopApi,
  type ProviderSetupInput,
  type TrainingCloseFirstInput,
  type TrainingConfirmInput,
  type TrainingHintLevel,
  type TrainingSecondInput,
  type TrainingStartInput,
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
  async startProviderCertification() {
    const value: unknown = await ipcRenderer.invoke(PROVIDER_CERTIFICATION_START_CHANNEL);
    return providerCertificationDraftSchema.parse(value);
  },
  async confirmProviderCertification(certificationId: string) {
    const id = providerCertificationIdSchema.parse(certificationId);
    const value: unknown = await ipcRenderer.invoke(
      PROVIDER_CERTIFICATION_CONFIRM_CHANNEL,
      id,
    );
    return providerCertificationResultSchema.parse(value);
  },
  async cancelProviderCertification(certificationId: string) {
    await ipcRenderer.invoke(
      PROVIDER_CERTIFICATION_CANCEL_CHANNEL,
      providerCertificationIdSchema.parse(certificationId),
    );
  },
  async startTraining(input: TrainingStartInput) {
    const value: unknown = await ipcRenderer.invoke(
      TRAINING_START_CHANNEL,
      trainingStartInputSchema.parse(input),
    );
    return trainingTurnStateSchema.parse(value);
  },
  async closeFirstAttempt(input: TrainingCloseFirstInput) {
    const value: unknown = await ipcRenderer.invoke(
      TRAINING_CLOSE_FIRST_CHANNEL,
      trainingCloseFirstInputSchema.parse(input),
    );
    return trainingTurnStateSchema.parse(value);
  },
  async requestDiagnosis() {
    const value: unknown = await ipcRenderer.invoke(TRAINING_DIAGNOSE_CHANNEL);
    return trainingTurnStateSchema.parse(value);
  },
  async requestHint(level: TrainingHintLevel) {
    const value: unknown = await ipcRenderer.invoke(
      TRAINING_HINT_CHANNEL,
      trainingHintLevelSchema.parse(level),
    );
    return trainingTurnStateSchema.parse(value);
  },
  async submitSecondAttempt(input: TrainingSecondInput) {
    const value: unknown = await ipcRenderer.invoke(
      TRAINING_SECOND_CHANNEL,
      trainingSecondInputSchema.parse(input),
    );
    return trainingTurnStateSchema.parse(value);
  },
  async extractCandidates() {
    const value: unknown = await ipcRenderer.invoke(TRAINING_EXTRACT_CHANNEL);
    return trainingTurnStateSchema.parse(value);
  },
  async confirmCandidates(input: TrainingConfirmInput) {
    const value: unknown = await ipcRenderer.invoke(
      TRAINING_CONFIRM_CHANNEL,
      trainingConfirmInputSchema.parse(input),
    );
    return trainingTurnStateSchema.parse(value);
  },
  async getDueModules() {
    const value: unknown = await ipcRenderer.invoke(TRAINING_DUE_CHANNEL);
    return trainingDueListSchema.parse(value);
  },
});

contextBridge.exposeInMainWorld('mentalLegos', desktopApi);
