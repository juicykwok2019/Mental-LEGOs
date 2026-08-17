import { contextBridge, ipcRenderer } from 'electron';

import {
  APP_INFO_CHANNEL,
  AGENT_READINESS_GET_CHANNEL,
  BASH_RUNTIME_INSTALL_CHANNEL,
  FOUNDATION_DELETE_KNOWLEDGE_CHANNEL,
  FOUNDATION_OVERVIEW_CHANNEL,
  FOUNDATION_RESOLVE_ASSERTION_CHANNEL,
  LIBRARY_ARCHIVE_CHANNEL,
  LIBRARY_DELETE_MODULE_CHANNEL,
  LIBRARY_DELETE_VERSION_CHANNEL,
  LIBRARY_LINK_CHANNEL,
  LIBRARY_LIST_CHANNEL,
  LIBRARY_RENAME_CHANNEL,
  LIBRARY_UNLINK_CHANNEL,
  LIBRARY_RESTORE_CHANNEL,
  LIBRARY_MODULE_DETAIL_CHANNEL,
  LIBRARY_PROMOTE_CHANNEL,
  LIBRARY_REAL_WORLD_CHANNEL,
  MATERIAL_PARSE_FILE_CHANNEL,
  RECORDING_DELETE_CHANNEL,
  RECORDING_LIST_CHANNEL,
  PRIVACY_EXPORT_CHANNEL,
  PRIVACY_IMPORT_CHANNEL,
  PRIVACY_OVERVIEW_CHANNEL,
  PROFILE_GET_CHANNEL,
  PROFILE_SAVE_CHANNEL,
  PROVIDER_SETUP_CLEAR_CHANNEL,
  PROVIDER_CERTIFICATION_CANCEL_CHANNEL,
  PROVIDER_CERTIFICATION_CONFIRM_CHANNEL,
  PROVIDER_CERTIFICATION_START_CHANNEL,
  PROVIDER_SETUP_GET_CHANNEL,
  PROVIDER_SETUP_SAVE_CHANNEL,
  RENDERER_READY_CHANNEL,
  SCENARIO_ADD_MATERIAL_CHANNEL,
  SCENARIO_CREATE_CHANNEL,
  SCENARIO_DELETE_CHANNEL,
  SCENARIO_DELETE_MATERIAL_CHANNEL,
  SCENARIO_DELETE_PREVIEW_CHANNEL,
  SCENARIO_COMPOSE_OUTLINE_CHANNEL,
  SCENARIO_MATERIAL_INTENT_CHANNEL,
  SCENARIO_LIST_CHANNEL,
  SCENARIO_PREPARE_CHANNEL,
  SCENARIO_TRANSFORM_OUTLINE_CHANNEL,
  SCENARIO_REVIEW_CHANNEL,
  SCENARIO_START_QUESTION_CHANNEL,
  SPEECH_INSTALL_CHANNEL,
  SPEECH_READINESS_CHANNEL,
  SPEECH_TRANSCRIBE_CHANNEL,
  TRAINING_CLOSE_FIRST_CHANNEL,
  TRAINING_CONFIRM_CHANNEL,
  TRAINING_DIAGNOSE_CHANNEL,
  TRAINING_DUE_CHANNEL,
  TRAINING_EXTRACT_CHANNEL,
  TRAINING_FOLLOW_UP_CHANNEL,
  TRAINING_GAP_CHANNEL,
  TRAINING_HINT_CHANNEL,
  TRAINING_REHEARSE_CHANNEL,
  TRAINING_SECOND_CHANNEL,
  TRAINING_START_CHANNEL,
  TRAINING_STATE_CHANNEL,
  TRAINING_VARIATION_ANSWER_CHANNEL,
  TRAINING_VARIATION_SKIP_CHANNEL,
  USAGE_OVERVIEW_CHANNEL,
  appInfoSchema,
  agentReadinessStateSchema,
  foundationOverviewSchema,
  foundationResolveAssertionInputSchema,
  libraryDeleteVersionInputSchema,
  libraryLinkInputSchema,
  libraryModuleDetailSchema,
  libraryRenameInputSchema,
  libraryUnlinkInputSchema,
  libraryModuleSummarySchema,
  libraryPromoteInputSchema,
  libraryRealWorldInputSchema,
  parsedMaterialFileSchema,
  recordingItemSchema,
  privacyExportResultSchema,
  privacyImportResultSchema,
  privacyOverviewSchema,
  profileSeedInputSchema,
  profileStateSchema,
  providerSetupInputSchema,
  providerSetupStateSchema,
  providerCertificationDraftSchema,
  providerCertificationIdSchema,
  providerCertificationResultSchema,
  scenarioCreateInputSchema,
  scenarioDeleteMaterialInputSchema,
  scenarioDeletePreviewSchema,
  scenarioComposeOutlineInputSchema,
  scenarioMaterialIntentInputSchema,
  scenarioTransformOutlineInputSchema,
  scenarioMaterialInputSchema,
  scenarioReviewInputSchema,
  scenarioSummarySchema,
  speechReadinessSchema,
  speechTranscriptionResultSchema,
  trainingCloseFirstInputSchema,
  trainingConfirmInputSchema,
  trainingDueListSchema,
  trainingGapInputSchema,
  trainingHintLevelSchema,
  trainingSecondInputSchema,
  trainingStartInputSchema,
  trainingTurnStateSchema,
  trainingVariationAnswerInputSchema,
  usageOverviewSchema,
  type MentalLegosDesktopApi,
  type FoundationResolveAssertionInput,
  type LibraryDeleteVersionInput,
  type LibraryLinkInput,
  type LibraryRenameInput,
  type LibraryUnlinkInput,
  type LibraryPromoteInput,
  type LibraryRealWorldInput,
  type ProfileSeedInput,
  type ProviderSetupInput,
  type ScenarioCreateInput,
  type ScenarioComposeOutlineInput,
  type ScenarioDeleteMaterialInput,
  type ScenarioMaterialInput,
  type ScenarioMaterialIntentInput,
  type ScenarioTransformOutlineInput,
  type ScenarioReviewInput,
  type TrainingCloseFirstInput,
  type TrainingConfirmInput,
  type TrainingGapInput,
  type TrainingHintLevel,
  type TrainingSecondInput,
  type TrainingStartInput,
  type TrainingVariationAnswerInput,
} from '../shared/contracts';
import { z } from 'zod';

async function invokeParsed<T>(
  channel: string,
  schema: z.ZodType<T>,
  payload?: unknown,
): Promise<T> {
  const value: unknown = payload === undefined
    ? await ipcRenderer.invoke(channel)
    : await ipcRenderer.invoke(channel, payload);
  return schema.parse(value);
}

const desktopApi: MentalLegosDesktopApi = Object.freeze({
  async getAppInfo() {
    return invokeParsed(APP_INFO_CHANNEL, appInfoSchema);
  },
  async reportReady() {
    await ipcRenderer.invoke(RENDERER_READY_CHANNEL);
  },
  async getProviderSetup() {
    return invokeParsed(PROVIDER_SETUP_GET_CHANNEL, providerSetupStateSchema);
  },
  async saveProviderSetup(input: ProviderSetupInput) {
    return invokeParsed(
      PROVIDER_SETUP_SAVE_CHANNEL,
      providerSetupStateSchema,
      providerSetupInputSchema.parse(input),
    );
  },
  async clearProviderSetup() {
    return invokeParsed(PROVIDER_SETUP_CLEAR_CHANNEL, providerSetupStateSchema);
  },
  async getAgentReadiness() {
    return invokeParsed(AGENT_READINESS_GET_CHANNEL, agentReadinessStateSchema);
  },
  async installBashRuntime() {
    return invokeParsed(BASH_RUNTIME_INSTALL_CHANNEL, agentReadinessStateSchema);
  },
  async startProviderCertification() {
    return invokeParsed(PROVIDER_CERTIFICATION_START_CHANNEL, providerCertificationDraftSchema);
  },
  async confirmProviderCertification(certificationId: string) {
    return invokeParsed(
      PROVIDER_CERTIFICATION_CONFIRM_CHANNEL,
      providerCertificationResultSchema,
      providerCertificationIdSchema.parse(certificationId),
    );
  },
  async cancelProviderCertification(certificationId: string) {
    await ipcRenderer.invoke(
      PROVIDER_CERTIFICATION_CANCEL_CHANNEL,
      providerCertificationIdSchema.parse(certificationId),
    );
  },
  async getProfile() {
    return invokeParsed(PROFILE_GET_CHANNEL, profileStateSchema);
  },
  async saveProfile(input: ProfileSeedInput) {
    return invokeParsed(PROFILE_SAVE_CHANNEL, profileStateSchema, profileSeedInputSchema.parse(input));
  },
  async getSpeechReadiness() {
    return invokeParsed(SPEECH_READINESS_CHANNEL, speechReadinessSchema);
  },
  async installSpeechModel() {
    return invokeParsed(SPEECH_INSTALL_CHANNEL, speechReadinessSchema);
  },
  async transcribeRecording(wav: ArrayBuffer) {
    if (!(wav instanceof ArrayBuffer) || wav.byteLength === 0) {
      throw new Error('Recording payload must be a non-empty ArrayBuffer.');
    }
    return invokeParsed(SPEECH_TRANSCRIBE_CHANNEL, speechTranscriptionResultSchema, wav);
  },
  async getTrainingState() {
    return invokeParsed(TRAINING_STATE_CHANNEL, trainingTurnStateSchema);
  },
  async parseMaterialFile() {
    return invokeParsed(MATERIAL_PARSE_FILE_CHANNEL, parsedMaterialFileSchema.nullable());
  },
  async getUsageOverview() {
    return invokeParsed(USAGE_OVERVIEW_CHANNEL, usageOverviewSchema);
  },
  async importBackup(password: string) {
    return invokeParsed(
      PRIVACY_IMPORT_CHANNEL,
      privacyImportResultSchema,
      z.string().min(8).max(200).parse(password),
    );
  },
  async composeSpeechOutline(input: ScenarioComposeOutlineInput) {
    return invokeParsed(
      SCENARIO_COMPOSE_OUTLINE_CHANNEL,
      scenarioSummarySchema,
      scenarioComposeOutlineInputSchema.parse(input),
    );
  },
  async transformSpeechOutline(input: ScenarioTransformOutlineInput) {
    return invokeParsed(
      SCENARIO_TRANSFORM_OUTLINE_CHANNEL,
      scenarioSummarySchema,
      scenarioTransformOutlineInputSchema.parse(input),
    );
  },
  async updateScenarioMaterialIntent(input: ScenarioMaterialIntentInput) {
    return invokeParsed(
      SCENARIO_MATERIAL_INTENT_CHANNEL,
      scenarioSummarySchema,
      scenarioMaterialIntentInputSchema.parse(input),
    );
  },
  async deleteScenarioMaterial(input: ScenarioDeleteMaterialInput) {
    return invokeParsed(
      SCENARIO_DELETE_MATERIAL_CHANNEL,
      scenarioSummarySchema,
      scenarioDeleteMaterialInputSchema.parse(input),
    );
  },
  async renameLibraryModule(input: LibraryRenameInput) {
    return invokeParsed(
      LIBRARY_RENAME_CHANNEL,
      libraryModuleDetailSchema,
      libraryRenameInputSchema.parse(input),
    );
  },
  async linkLibraryModules(input: LibraryLinkInput) {
    return invokeParsed(
      LIBRARY_LINK_CHANNEL,
      libraryModuleDetailSchema,
      libraryLinkInputSchema.parse(input),
    );
  },
  async unlinkLibraryModules(input: LibraryUnlinkInput) {
    return invokeParsed(
      LIBRARY_UNLINK_CHANNEL,
      libraryModuleDetailSchema,
      libraryUnlinkInputSchema.parse(input),
    );
  },
  async getFoundationOverview() {
    return invokeParsed(FOUNDATION_OVERVIEW_CHANNEL, foundationOverviewSchema);
  },
  async resolveFoundationAssertion(input: FoundationResolveAssertionInput) {
    return invokeParsed(
      FOUNDATION_RESOLVE_ASSERTION_CHANNEL,
      foundationOverviewSchema,
      foundationResolveAssertionInputSchema.parse(input),
    );
  },
  async deleteFoundationKnowledge(knowledgeId: string) {
    return invokeParsed(
      FOUNDATION_DELETE_KNOWLEDGE_CHANNEL,
      foundationOverviewSchema,
      z.string().uuid().parse(knowledgeId),
    );
  },
  async deleteLibraryModule(moduleId: string) {
    await ipcRenderer.invoke(LIBRARY_DELETE_MODULE_CHANNEL, z.string().uuid().parse(moduleId));
  },
  async restoreLibraryModule(moduleId: string) {
    return invokeParsed(
      LIBRARY_RESTORE_CHANNEL,
      libraryModuleDetailSchema,
      z.string().uuid().parse(moduleId),
    );
  },
  async deleteModuleVersion(input: LibraryDeleteVersionInput) {
    return invokeParsed(
      LIBRARY_DELETE_VERSION_CHANNEL,
      libraryModuleDetailSchema,
      libraryDeleteVersionInputSchema.parse(input),
    );
  },
  async listRecordings() {
    return invokeParsed(RECORDING_LIST_CHANNEL, z.array(recordingItemSchema));
  },
  async deleteRecording(recordingId: string) {
    return invokeParsed(
      RECORDING_DELETE_CHANNEL,
      z.array(recordingItemSchema),
      z.string().uuid().parse(recordingId),
    );
  },
  async startTraining(input: TrainingStartInput) {
    return invokeParsed(TRAINING_START_CHANNEL, trainingTurnStateSchema, trainingStartInputSchema.parse(input));
  },
  async closeFirstAttempt(input: TrainingCloseFirstInput) {
    return invokeParsed(
      TRAINING_CLOSE_FIRST_CHANNEL,
      trainingTurnStateSchema,
      trainingCloseFirstInputSchema.parse(input),
    );
  },
  async resolveGap(input: TrainingGapInput) {
    return invokeParsed(TRAINING_GAP_CHANNEL, trainingTurnStateSchema, trainingGapInputSchema.parse(input));
  },
  async requestDiagnosis() {
    return invokeParsed(TRAINING_DIAGNOSE_CHANNEL, trainingTurnStateSchema);
  },
  async requestHint(level: TrainingHintLevel) {
    return invokeParsed(TRAINING_HINT_CHANNEL, trainingTurnStateSchema, trainingHintLevelSchema.parse(level));
  },
  async submitSecondAttempt(input: TrainingSecondInput) {
    return invokeParsed(
      TRAINING_SECOND_CHANNEL,
      trainingTurnStateSchema,
      trainingSecondInputSchema.parse(input),
    );
  },
  async rehearseSpeech(input: TrainingSecondInput) {
    return invokeParsed(
      TRAINING_REHEARSE_CHANNEL,
      trainingTurnStateSchema,
      trainingSecondInputSchema.parse(input),
    );
  },
  async extractCandidates() {
    return invokeParsed(TRAINING_EXTRACT_CHANNEL, trainingTurnStateSchema);
  },
  async confirmCandidates(input: TrainingConfirmInput) {
    return invokeParsed(
      TRAINING_CONFIRM_CHANNEL,
      trainingTurnStateSchema,
      trainingConfirmInputSchema.parse(input),
    );
  },
  async answerVariation(input: TrainingVariationAnswerInput) {
    return invokeParsed(
      TRAINING_VARIATION_ANSWER_CHANNEL,
      trainingTurnStateSchema,
      trainingVariationAnswerInputSchema.parse(input),
    );
  },
  async skipVariation() {
    return invokeParsed(TRAINING_VARIATION_SKIP_CHANNEL, trainingTurnStateSchema);
  },
  async askFollowUp() {
    return invokeParsed(TRAINING_FOLLOW_UP_CHANNEL, trainingTurnStateSchema);
  },
  async getDueModules() {
    return invokeParsed(TRAINING_DUE_CHANNEL, trainingDueListSchema);
  },
  async listScenarios() {
    return invokeParsed(SCENARIO_LIST_CHANNEL, z.array(scenarioSummarySchema));
  },
  async createScenario(input: ScenarioCreateInput) {
    return invokeParsed(SCENARIO_CREATE_CHANNEL, scenarioSummarySchema, scenarioCreateInputSchema.parse(input));
  },
  async addScenarioMaterial(input: ScenarioMaterialInput) {
    return invokeParsed(
      SCENARIO_ADD_MATERIAL_CHANNEL,
      scenarioSummarySchema,
      scenarioMaterialInputSchema.parse(input),
    );
  },
  async prepareScenario(scenarioId: string) {
    return invokeParsed(SCENARIO_PREPARE_CHANNEL, scenarioSummarySchema, z.string().uuid().parse(scenarioId));
  },
  async startScenarioQuestion(scenarioId: string, questionId: string) {
    return invokeParsed(SCENARIO_START_QUESTION_CHANNEL, trainingTurnStateSchema, {
      scenarioId: z.string().uuid().parse(scenarioId),
      questionId: z.string().uuid().parse(questionId),
    });
  },
  async reviewScenario(input: ScenarioReviewInput) {
    return invokeParsed(SCENARIO_REVIEW_CHANNEL, trainingTurnStateSchema, scenarioReviewInputSchema.parse(input));
  },
  async previewScenarioDeletion(scenarioId: string) {
    return invokeParsed(
      SCENARIO_DELETE_PREVIEW_CHANNEL,
      scenarioDeletePreviewSchema,
      z.string().uuid().parse(scenarioId),
    );
  },
  async deleteScenario(scenarioId: string) {
    return invokeParsed(
      SCENARIO_DELETE_CHANNEL,
      scenarioDeletePreviewSchema,
      z.string().uuid().parse(scenarioId),
    );
  },
  async listLibraryModules() {
    return invokeParsed(LIBRARY_LIST_CHANNEL, z.array(libraryModuleSummarySchema));
  },
  async getLibraryModule(moduleId: string) {
    return invokeParsed(
      LIBRARY_MODULE_DETAIL_CHANNEL,
      libraryModuleDetailSchema,
      z.string().uuid().parse(moduleId),
    );
  },
  async archiveLibraryModule(moduleId: string) {
    await ipcRenderer.invoke(LIBRARY_ARCHIVE_CHANNEL, z.string().uuid().parse(moduleId));
  },
  async promoteLibraryModule(input: LibraryPromoteInput) {
    return invokeParsed(
      LIBRARY_PROMOTE_CHANNEL,
      libraryModuleSummarySchema,
      libraryPromoteInputSchema.parse(input),
    );
  },
  async reportRealWorldUse(input: LibraryRealWorldInput) {
    await ipcRenderer.invoke(LIBRARY_REAL_WORLD_CHANNEL, libraryRealWorldInputSchema.parse(input));
  },
  async getPrivacyOverview() {
    return invokeParsed(PRIVACY_OVERVIEW_CHANNEL, privacyOverviewSchema);
  },
  async exportEncryptedData(password: string) {
    return invokeParsed(
      PRIVACY_EXPORT_CHANNEL,
      privacyExportResultSchema,
      z.string().min(8).max(200).parse(password),
    );
  },
});

contextBridge.exposeInMainWorld('mentalLegos', desktopApi);
