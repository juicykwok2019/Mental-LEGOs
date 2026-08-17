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

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}
