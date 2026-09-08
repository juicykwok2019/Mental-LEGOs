// Chinese display labels for internal enum values. Fall back to the raw value
// so an unknown enum member never renders as blank.

// The functional role a brick plays in a conversation.
const CATEGORY_LABELS: Record<string, string> = {
  'opening': '开场接题',
  'scoping': '界定范围',
  'viewpoint': '观点判断',
  'reasoning': '推理论证',
  'evidence': '证据支撑',
  'case': '案例经验',
  'interaction': '互动应对',
  'transition': '过渡衔接',
  'closing': '收尾落点',
  'speech-composite': '演讲组合',
};

// Nine mastery stages, from freshly confirmed to proven in the real world.
const STAGE_LABELS: Record<string, string> = {
  'candidate': '候选',
  'confirmed': '刚确认',
  'visible-recall': '看着能说',
  'prompted-recall': '提示能说',
  'independent-recall': '独立调用',
  'transfer': '换题能用',
  'composition': '组合运用',
  'pressure': '抗压运用',
  'real-world': '现实验证',
};

const TIER_LABELS: Record<string, string> = {
  'confirmed-fact': '已确认事实',
  'evidenced-observation': '有据观察',
  'pending-hypothesis': '待验假设',
};

const KNOWLEDGE_KIND_LABELS: Record<string, string> = {
  'fact': '事实',
  'case': '案例',
  'viewpoint': '观点',
  'method': '方法',
  'preference': '偏好',
  'assumption': '待思考',
};

// Where a version's wording came from.
const AUTHORSHIP_LABELS: Record<string, string> = {
  'user-native': '本人表达',
  'co-extracted': '共同提炼',
  'agent-candidate': '助手草拟',
};

const RELATION_LABELS: Record<string, string> = {
  'composes-with': '可组合',
  'similar-to': '相似',
  'conflicts-with': '互斥',
  'precedes': '先于',
};

export function authorshipLabel(authorship: string): string {
  return AUTHORSHIP_LABELS[authorship] ?? authorship;
}

export function relationLabel(relation: string): string {
  return RELATION_LABELS[relation] ?? relation;
}

export function tierLabel(tier: string): string {
  return TIER_LABELS[tier] ?? tier;
}

export function knowledgeKindLabel(kind: string): string {
  return KNOWLEDGE_KIND_LABELS[kind] ?? kind;
}

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}
