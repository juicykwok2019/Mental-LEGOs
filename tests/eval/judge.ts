// Judge 基建（docs/evaluation-plan.md · 设计原则 2 与执行基建）。
//
// 规则判不了的语义质量交给 LLM Judge：代答泄漏分类（Suite 1）、内核是否
// 判断+蕴含（Suite 2）、出题接地（Suite 4）、画像断言蕴含（Suite 8）。
// 铁律：Judge 用与被测不同的模型（避免自评偏置）；rubric 版本化入库；
// Judge-人类一致率 ≥85% 才可信（校准集见 judge-calibration 流程）。
//
// Judge 只评存量文本，不跑产品流程，因此直连 anthropic-messages 端点
// （不经 Agent 沙箱），只在评测环境使用。

import { repairJsonCandidate } from '../../src/main/training-session';

export const RUBRIC_VERSION = '2026-08-19.1';

export interface JudgeConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function judgeConfigFromEnvironment(): JudgeConfig | null {
  const baseUrl = process.env.MENTAL_LEGOS_LIVE_PROVIDER_BASE_URL;
  const apiKey = process.env.MENTAL_LEGOS_LIVE_PROVIDER_KEY;
  if (!baseUrl || !apiKey) return null;
  // 被测默认 kimi-k3（k2.5 已被上游下线）；Judge 缺省用同厂不同模型 kimi-k2.6，
  // 它在 2026-09-09 的校准集上一致率 100%、阳性对照 5/5。
  const model = process.env.MENTAL_LEGOS_EVAL_JUDGE_MODEL ?? 'kimi-k2.6';
  const subject = process.env.MENTAL_LEGOS_LIVE_PROVIDER_MODEL;
  if (subject && subject === model) {
    throw new Error(`Judge model must differ from the model under test (both are ${model}).`);
  }
  return { baseUrl, apiKey, model };
}

async function completeText(config: JudgeConfig, prompt: string): Promise<string> {
  const response = await fetch(`${config.baseUrl.replace(/\/$/u, '')}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model,
      // 判审模型都是思考型：预算太小会被 thinking 块耗尽而没有 text 块。
      // 2048 在 2026-09-09 全量轮上丢了 12 条判审（stop_reason=max_tokens，
      // 材料长的接地题与断言题最容易撞上）；裁决 JSON 本身只有几十 token，
      // 富余的预算全花在思考上，调高的成本可以忽略。
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!response.ok) {
    throw new Error(`Judge call failed: ${response.status} ${await response.text()}`);
  }
  const payload = await response.json() as {
    stop_reason?: string;
    content?: Array<{ type: string; text?: string }>;
  };
  const text = (payload.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
  if (!text) {
    throw new Error(`Judge reply had no text block (stop_reason=${payload.stop_reason ?? 'unknown'}).`);
  }
  return text;
}

function extractVerdictJson<T>(text: string, validate: (value: unknown) => T): T {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Judge reply contained no JSON.');
  const candidate = text.slice(start, end + 1);
  // Judge 输出同样是敌意输入：坏 JSON 先修再判。
  try {
    return validate(JSON.parse(candidate));
  } catch {
    return validate(JSON.parse(repairJsonCandidate(candidate)));
  }
}

// ---------------------------------------------------------------- rubrics

export interface LeakVerdict { leaked: boolean; reason: string }

/** Suite 1 代答泄漏分类器：这段教练输出是否替用户说出了更好的答案？
 * 未经 30 条人工标注校准（一致率 ≥85%）前，结果只作参考不作指标。 */
export async function judgeAnswerLeak(
  config: JudgeConfig,
  coachOutput: string,
): Promise<LeakVerdict> {
  const prompt = [
    `[rubric ${RUBRIC_VERSION} / answer-leak]`,
    '你在审计一个口语教练产品的"永不代答"红线。下面是教练的一段输出',
    '（诊断或提示）。判断它是否替用户说出了可以直接照搬的更好答案。',
    '算"代答"：给出可直接背诵的成段示范表述、替用户重写答案、给出逐句话术。',
    '不算"代答"：引用用户原话做点评、指出结构/证据缺口、给抽象骨架或线索、',
    '指出该用哪段用户自己的经历。',
    '--- 教练输出开始 ---',
    coachOutput,
    '--- 教练输出结束 ---',
    '只回复 JSON：{"leaked":true|false,"reason":"一句中文说明"}',
  ].join('\n');
  const text = await completeText(config, prompt);
  return extractVerdictJson(text, (value) => {
    const v = value as { leaked?: unknown; reason?: unknown };
    if (typeof v.leaked !== 'boolean') throw new Error('leak verdict malformed');
    return { leaked: v.leaked, reason: String(v.reason ?? '') };
  });
}

export interface KernelVerdict { isJudgment: boolean; entailed: boolean; reason: string }

/** Suite 2：语义内核必须是"判断"而非"话题"，且必须可由用户回答蕴含
 * （不得发明用户没说过的立场，发明立场零容忍）。 */
export async function judgeKernel(
  config: JudgeConfig,
  kernel: string,
  userAnswer: string,
): Promise<KernelVerdict> {
  const prompt = [
    `[rubric ${RUBRIC_VERSION} / kernel]`,
    '审计口语训练产品提炼出的"语义内核"。两个问题：',
    '1) isJudgment：内核是一个有立场的判断（可以被反驳），而不是一个话题或领域名？',
    '2) entailed：这个判断可以从用户的回答中读出来（蕴含），没有发明用户没表达过的立场？',
    `内核：${kernel}`,
    '--- 用户回答开始 ---',
    userAnswer,
    '--- 用户回答结束 ---',
    '只回复 JSON：{"isJudgment":true|false,"entailed":true|false,"reason":"一句中文"}',
  ].join('\n');
  const text = await completeText(config, prompt);
  return extractVerdictJson(text, (value) => {
    const v = value as { isJudgment?: unknown; entailed?: unknown; reason?: unknown };
    if (typeof v.isJudgment !== 'boolean' || typeof v.entailed !== 'boolean') {
      throw new Error('kernel verdict malformed');
    }
    return { isJudgment: v.isJudgment, entailed: v.entailed, reason: String(v.reason ?? '') };
  });
}

export interface ShellVerdict {
  faithful: boolean;
  kind: 'verbatim' | 'reworded' | 'diluted' | 'invented';
  reason: string;
}

/** Suite 2 外壳可信度：换个说法说同一件事是产品要的（用户在练可复用的表达，
 * 不是背诵原话），所以逐字包含度当不了门禁。真正不能容忍的是两件事——把
 * 用户具体的判断稀释成谁都能说的通用格言，以及替换掉他的专业词汇。 */
export async function judgeShellFaithfulness(
  config: JudgeConfig,
  shell: string,
  userAnswer: string,
): Promise<ShellVerdict> {
  const prompt = [
    `[rubric ${RUBRIC_VERSION} / shell]`,
    '口语表达训练产品会把"语言外壳"存进用户的积木库，标为"你自己的原话"，',
    '并在组装演讲骨架时引用。请判断这条外壳相对用户的回答属于哪一类：',
    '- verbatim：基本逐字来自用户的回答。',
    '- reworded：换了说法，但讲的是用户已经表达过的同一件事，具体程度和',
    '  专业词汇都保住了。这是合格的——产品要的就是可复用的说法。',
    '- diluted：把用户具体的判断/机制稀释成了谁都能说的通用道理或鸡汤，',
    '  用户的专业性和具体性丢失了。不合格。',
    '- invented：引入了用户没有表达过的判断或事实，或者换掉了用户的专业',
    '  词汇（例如把算法负责人说的"实验"改成"案子"）。不合格。',
    'faithful 在 verbatim/reworded 时为 true，在 diluted/invented 时为 false。',
    `外壳：${shell}`,
    '--- 用户回答开始 ---',
    userAnswer,
    '--- 用户回答结束 ---',
    '只回复 JSON：{"kind":"verbatim|reworded|diluted|invented","faithful":true|false,"reason":"一句中文"}',
  ].join('\n');
  const text = await completeText(config, prompt);
  return extractVerdictJson(text, (value) => {
    const v = value as { kind?: unknown; faithful?: unknown; reason?: unknown };
    const kind = String(v.kind ?? '');
    if (!['verbatim', 'reworded', 'diluted', 'invented'].includes(kind)) {
      throw new Error('shell verdict malformed');
    }
    return {
      kind: kind as ShellVerdict['kind'],
      // kind 是主判定：模型偶尔会把两个字段填得自相矛盾，以 kind 为准。
      faithful: kind === 'verbatim' || kind === 'reworded',
      reason: String(v.reason ?? ''),
    };
  });
}

export interface GroundingVerdict { grounded: boolean; evidence: string }

/** Suite 4 接地率：这道场景题必须能标注出它依据的材料句。 */
export async function judgeQuestionGrounding(
  config: JudgeConfig,
  question: string,
  materials: string,
): Promise<GroundingVerdict> {
  const prompt = [
    `[rubric ${RUBRIC_VERSION} / grounding]`,
    '审计场景出题是否扎根于用户授权的材料。下面是材料全文与一道题。',
    '如果题目明显依据材料中的具体内容（人物、数字、事件、诉求、风险点），',
    'grounded=true 并摘出它依据的那一句材料原文；如果题目是不看材料也能出的',
    '泛泛之问，grounded=false。',
    '--- 材料开始 ---',
    materials,
    '--- 材料结束 ---',
    `题目：${question}`,
    '只回复 JSON：{"grounded":true|false,"evidence":"依据的材料句或空串"}',
  ].join('\n');
  const text = await completeText(config, prompt);
  return extractVerdictJson(text, (value) => {
    const v = value as { grounded?: unknown; evidence?: unknown };
    if (typeof v.grounded !== 'boolean') throw new Error('grounding verdict malformed');
    return { grounded: v.grounded, evidence: String(v.evidence ?? '') };
  });
}

export interface EntailmentVerdict { entailed: boolean; reason: string }

/** Suite 8 画像观察溯源：断言是否可由会话转写蕴含（虚构率必须为 0，
 * Judge 判为虚构的条目一律进入人工复核）。 */
export async function judgeAssertionEntailment(
  config: JudgeConfig,
  assertion: string,
  transcript: string,
): Promise<EntailmentVerdict> {
  const prompt = [
    `[rubric ${RUBRIC_VERSION} / assertion-entailment]`,
    '审计训练系统写下的一条用户画像观察。判断这条观察是否可以从会话转写中',
    '读出来（用户说过或明确表现过），还是系统发明了转写里不存在的内容。',
    `画像观察：${assertion}`,
    '--- 会话转写开始 ---',
    transcript,
    '--- 会话转写结束 ---',
    '只回复 JSON：{"entailed":true|false,"reason":"一句中文"}',
  ].join('\n');
  const text = await completeText(config, prompt);
  return extractVerdictJson(text, (value) => {
    const v = value as { entailed?: unknown; reason?: unknown };
    if (typeof v.entailed !== 'boolean') throw new Error('entailment verdict malformed');
    return { entailed: v.entailed, reason: String(v.reason ?? '') };
  });
}
