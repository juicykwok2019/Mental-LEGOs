import { z } from 'zod';

export const providerIdSchema = z.enum([
  'anthropic',
  'kimi-open-platform',
  'deepseek',
  'zhipu',
  'custom',
]);
export type ProviderId = z.infer<typeof providerIdSchema>;

export const providerProtocolSchema = z.enum([
  'anthropic-messages',
  'openai-chat-completions',
]);
export type ProviderProtocol = z.infer<typeof providerProtocolSchema>;

export const providerCertificationSchema = z.enum([
  'baseline-pending-user-key',
  'official-compatible-pending-app-certification',
  'custom-unverified',
]);

export const providerDefinitionSchema = z.object({
  id: providerIdSchema.exclude(['custom']),
  displayName: z.string().min(1),
  baseUrl: z.string().url(),
  protocol: providerProtocolSchema,
  recommendedModels: z.array(z.string().min(1)).min(1),
  certification: providerCertificationSchema.exclude(['custom-unverified']),
  officialSource: z.string().url(),
  keySourceLabel: z.string().min(1),
  keySourceUrl: z.string().url(),
  reviewedOn: z.string().date(),
  billingNotice: z.string().min(1),
  usageNotice: z.string().min(1),
});

export type ProviderDefinition = z.infer<typeof providerDefinitionSchema>;

export const providerRegistry = Object.freeze([
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    protocol: 'anthropic-messages',
    recommendedModels: ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001'],
    certification: 'baseline-pending-user-key',
    officialSource: 'https://platform.claude.com/docs/en/about-claude/models/overview',
    keySourceLabel: 'Anthropic Console API Key',
    keySourceUrl: 'https://console.anthropic.com/settings/keys',
    reviewedOn: '2026-08-14',
    billingNotice: '使用 Anthropic API 账户的余额与计费规则。',
    usageNotice: 'Use a Claude API key and the API terms attached to that key.',
  },
  {
    id: 'kimi-open-platform',
    displayName: 'Kimi 开放平台（API Key / 按量计费）',
    baseUrl: 'https://api.moonshot.cn/anthropic',
    protocol: 'anthropic-messages',
    recommendedModels: [
      'kimi-k3',
      'kimi-k2.7-code',
      'kimi-k2.7-code-highspeed',
      'kimi-k2.6',
      'kimi-k2.5',
    ],
    certification: 'official-compatible-pending-app-certification',
    officialSource: 'https://platform.kimi.com/docs/guide/claude-code-kimi',
    keySourceLabel: 'Kimi 开放平台 API Key',
    keySourceUrl: 'https://platform.kimi.com/console/api-keys',
    reviewedOn: '2026-08-17',
    billingNotice: '使用 Kimi 开放平台余额并按量计费；开放平台官方 Anthropic 兼容端点，无需本地协议转换。',
    usageNotice: 'Official Moonshot Anthropic-compatible endpoint with pay-as-you-go Open Platform keys; Kimi Code subscription keys are a separate restricted product and are not supported.',
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    protocol: 'anthropic-messages',
    recommendedModels: ['deepseek-v4-pro', 'deepseek-v4-flash'],
    certification: 'official-compatible-pending-app-certification',
    officialSource: 'https://api-docs.deepseek.com/guides/anthropic_api',
    keySourceLabel: 'DeepSeek 开放平台 API Key',
    keySourceUrl: 'https://platform.deepseek.com/api_keys',
    reviewedOn: '2026-08-14',
    billingNotice: '使用 DeepSeek 开放平台账户的余额与计费规则。',
    usageNotice: 'Official Anthropic-format API; full Mental LEGOs Agent capability testing still requires a user-supplied standard API key.',
  },
  {
    id: 'zhipu',
    displayName: 'Zhipu AI',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    protocol: 'anthropic-messages',
    recommendedModels: ['glm-5.2'],
    certification: 'official-compatible-pending-app-certification',
    officialSource: 'https://docs.bigmodel.cn/cn/guide/develop/claude/introduction',
    keySourceLabel: '智谱开放平台 API Key',
    keySourceUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    reviewedOn: '2026-08-14',
    billingNotice: '使用智谱开放平台账户的余额与计费规则。',
    usageNotice: 'Use standard API rights valid for custom applications; do not assume a restricted Coding Plan subscription is eligible.',
  },
] satisfies ProviderDefinition[]);

export const providerProfileSchema = z.object({
  id: z.string().uuid(),
  providerId: providerIdSchema,
  displayName: z.string().trim().min(1).max(80),
  baseUrl: z.string().min(1),
  protocol: providerProtocolSchema.default('anthropic-messages'),
  model: z.string().trim().min(1).max(120),
  credentialReference: z.string().regex(/^(?:session|windows):model:[a-f0-9-]{36}$/u),
  certification: providerCertificationSchema,
});

export type ProviderProfile = z.infer<typeof providerProfileSchema>;

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] !== undefined && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

export function normalizeProviderBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('Provider Base URL must use HTTPS.');
  if (url.username || url.password) throw new Error('Provider Base URL cannot contain credentials.');
  if (url.search || url.hash) throw new Error('Provider Base URL cannot contain a query or fragment.');
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname === '::1' || hostname.endsWith('.localhost')
    || isPrivateIpv4(hostname)) {
    throw new Error('Provider Base URL cannot target a local or private-network address.');
  }
  url.pathname = url.pathname.replace(/\/+$/u, '');
  return url.toString().replace(/\/$/u, '');
}

export function createProviderProfile(input: {
  id: string;
  providerId: ProviderId;
  displayName: string;
  baseUrl: string;
  model: string;
  credentialReference: string;
}): ProviderProfile {
  const preset = providerRegistry.find((provider) => provider.id === input.providerId);
  const normalizedBaseUrl = normalizeProviderBaseUrl(input.baseUrl);
  const certification = preset && normalizedBaseUrl === preset.baseUrl
    ? preset.certification
    : 'custom-unverified';
  const protocol = preset?.protocol ?? 'anthropic-messages';

  return providerProfileSchema.parse({
    ...input,
    baseUrl: normalizedBaseUrl,
    protocol,
    certification,
  });
}
