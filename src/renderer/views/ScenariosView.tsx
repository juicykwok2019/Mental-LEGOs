import { useEffect, useRef, useState } from 'react';

import {
  AGENT_EXCERPT_CHARACTERS,
  HIGH_COST_CONFIRM_CHARACTERS,
  type ScenarioCreateInput,
  type ScenarioDeletePreview,
  type ScenarioSummary,
} from '../../shared/contracts';
import { BusyIndicator } from '../components/BusyIndicator';
import { decodeAudioFileToWav } from '../recorder';

function messageFrom(reason: unknown): string {
  return reason instanceof Error ? reason.message : '发生了未知错误。';
}

const TYPE_LABELS: Record<ScenarioCreateInput['type'], string> = {
  interview: '面试',
  meeting: '会议/汇报',
  negotiation: '谈判',
  client: '客户沟通',
  speech: '公开演讲',
  other: '其他',
};

export interface ScenariosViewProps {
  busy: boolean;
  creating: boolean;
  onOpenQuestion(scenarioId: string, questionId: string): void;
  onReview(input: { scenarioId: string; transcript: string; outcomeNote: string }): void;
  onCloseCreate(): void;
}

export function ScenariosView(props: ScenariosViewProps) {
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState('');
  const [showCreate, setShowCreate] = useState(props.creating);
  const [form, setForm] = useState<ScenarioCreateInput>({
    type: 'interview', title: '', objective: '', counterpart: '', worries: '',
  });
  const [materialLabel, setMaterialLabel] = useState('');
  const [materialContent, setMaterialContent] = useState('');
  const [materialIntent, setMaterialIntent] = useState('');
  const [materialNotice, setMaterialNotice] = useState<string | null>(null);
  const [reviewNotice, setReviewNotice] = useState<string | null>(null);
  const [materialToDelete, setMaterialToDelete] = useState<string | null>(null);
  const [intentEditId, setIntentEditId] = useState<string | null>(null);
  const [intentDraft, setIntentDraft] = useState('');
  const [outlineMinutes, setOutlineMinutes] = useState(10);
  const [outlineAudience, setOutlineAudience] = useState('');
  const audioInputRef = useRef<HTMLInputElement | null>(null);
  const materialAudioRef = useRef<HTMLInputElement | null>(null);
  const [reviewTranscript, setReviewTranscript] = useState('');
  const [reviewNote, setReviewNote] = useState('');
  const [deletePreview, setDeletePreview] = useState<ScenarioDeletePreview | null>(null);
  const [costConfirm, setCostConfirm] = useState<'prepare' | 'review' | null>(null);

  const selected = scenarios.find((scenario) => scenario.id === selectedId) ?? null;

  async function refresh(): Promise<void> {
    try {
      setScenarios(await window.mentalLegos.listScenarios());
    } catch (reason) {
      setError(messageFrom(reason));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function step(label: string, work: () => Promise<unknown>): Promise<void> {
    setWorking(label);
    setError(null);
    try {
      await work();
      await refresh();
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setWorking('');
    }
  }

  if (showCreate) {
    return (
      <div className="scenario-view">
        <h2 className="view-title">创建专项场景</h2>
        <div className="scenario-form">
          <label>
            <span>类型</span>
            <select
              value={form.type}
              onChange={(event) => setForm({ ...form, type: event.target.value as ScenarioCreateInput['type'] })}
            >
              {Object.entries(TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>这次交流是什么</span>
            <input
              value={form.title}
              maxLength={200}
              placeholder="例如：某公司产品负责人终面"
              onChange={(event) => setForm({ ...form, title: event.target.value })}
            />
          </label>
          <label>
            <span>对方是谁</span>
            <input
              value={form.counterpart}
              maxLength={400}
              placeholder="例如：CTO + HRBP"
              onChange={(event) => setForm({ ...form, counterpart: event.target.value })}
            />
          </label>
          <label>
            <span>我希望实现什么结果</span>
            <textarea
              value={form.objective}
              onChange={(event) => setForm({ ...form, objective: event.target.value })}
            />
          </label>
          <label>
            <span>我担心被问到什么</span>
            <textarea
              value={form.worries}
              onChange={(event) => setForm({ ...form, worries: event.target.value })}
            />
          </label>
          <div className="phase-actions">
            <button
              type="button"
              disabled={working !== '' || form.title.trim().length === 0}
              onClick={() => void step('创建中…', async () => {
                const created = await window.mentalLegos.createScenario({
                  ...form, title: form.title.trim(),
                });
                setSelectedId(created.id);
                setShowCreate(false);
                props.onCloseCreate();
              })}
            >
              创建
            </button>
            <button type="button" className="quiet-button" onClick={() => { setShowCreate(false); props.onCloseCreate(); }}>
              取消
            </button>
          </div>
          {error && <p className="form-error">{error}</p>}
        </div>
      </div>
    );
  }

  if (selected) {
    const materialSection = (
        <section className="scenario-block" key="materials">
          <h3>材料<span className="count-pill">{selected.materialCount}</span></h3>
          {selected.materials.length > 0 && (
            <ul className="version-list">
              {selected.materials.map((material) => (
                <li key={material.id}>
                  <span>
                    {material.label} · {material.characters.toLocaleString()} 字符 ·{' '}
                    {material.addedAt.slice(0, 10)}
                    {intentEditId === material.id ? (
                      <span className="intent-edit-row">
                        <input
                          value={intentDraft}
                          maxLength={2000}
                          placeholder="希望这份材料怎么用（留空即清除）"
                          onChange={(event) => setIntentDraft(event.target.value)}
                        />
                        <button
                          type="button"
                          className="quiet-button"
                          disabled={working !== ''}
                          onClick={() => void step('保存期望…', async () => {
                            await window.mentalLegos.updateScenarioMaterialIntent({
                              scenarioId: selected.id,
                              sourceId: material.id,
                              intent: intentDraft.trim(),
                            });
                            setIntentEditId(null);
                          })}
                        >
                          保存
                        </button>
                        <button type="button" className="quiet-button" onClick={() => setIntentEditId(null)}>
                          取消
                        </button>
                      </span>
                    ) : (
                      material.intent && <em className="material-intent">期望：{material.intent}</em>
                    )}
                  </span>
                  {materialToDelete === material.id ? (
                    <span className="phase-actions">
                      <button
                        type="button"
                        className="quiet-button"
                        disabled={working !== ''}
                        onClick={() => void step('删除材料…', async () => {
                          await window.mentalLegos.deleteScenarioMaterial({
                            scenarioId: selected.id,
                            sourceId: material.id,
                          });
                          setMaterialToDelete(null);
                        })}
                      >
                        确认删除
                      </button>
                      <button
                        type="button"
                        className="quiet-button"
                        onClick={() => setMaterialToDelete(null)}
                      >
                        取消
                      </button>
                    </span>
                  ) : (
                    <span className="phase-actions">
                      <button
                        type="button"
                        className="quiet-button intent-edit-button"
                        disabled={working !== ''}
                        onClick={() => {
                          setIntentDraft(material.intent);
                          setIntentEditId(material.id);
                        }}
                      >
                        {material.intent ? '改期望' : '加期望'}
                      </button>
                      <button
                        type="button"
                        className="quiet-button"
                        disabled={working !== ''}
                        onClick={() => setMaterialToDelete(material.id)}
                      >
                        删除
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="block-hint">
            导入 JD、简历、方案等资料，系统据此生成针对性问题。选择文件，或直接把文本粘贴到下面。
          </p>
          <div className="phase-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={working !== ''}
              onClick={() => void step('解析文件…', async () => {
                const parsed = await window.mentalLegos.parseMaterialFile();
                if (!parsed) return;
                setMaterialLabel((current) => (current.trim() ? current : parsed.fileName));
                setMaterialContent(parsed.text);
                setMaterialNotice(parsed.warnings.length > 0
                  ? parsed.warnings.join(' ')
                  : `已从「${parsed.fileName}」提取 ${parsed.text.length} 字符。确认内容无误后再授权导入。`);
              })}
            >
              📄 选择文件（PDF / Word / 文本）
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={working !== ''}
              onClick={() => materialAudioRef.current?.click()}
            >
              🎧 导入录音并本地转写（wav / mp3 / m4a）
            </button>
            <input
              ref={materialAudioRef}
              type="file"
              accept="audio/*,.m4a,.aac"
              style={{ display: 'none' }}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (!file) return;
                void step('本地转写录音（长录音需要几分钟）…', async () => {
                  const bytes = await file.arrayBuffer();
                  const decoded = await decodeAudioFileToWav(bytes);
                  const result = await window.mentalLegos.transcribeRecording(decoded.wav);
                  if (!result.text.trim()) {
                    setMaterialNotice(`「${file.name}」转写结果为空——录音里可能没有清晰人声。`);
                    return;
                  }
                  setMaterialLabel((current) => (current.trim() ? current : file.name));
                  setMaterialContent((current) => (current ? `${current}\n${result.text}` : result.text));
                  setMaterialNotice(`✓ 已本地转写「${file.name}」（${Math.round(result.audioDurationSeconds / 60)} 分钟音频），音频未离开本机。确认文本后再授权导入。`);
                });
              }}
            />
          </div>
          <input
            placeholder="材料名称，例如：JD / 我的简历 / 方案摘要"
            value={materialLabel}
            maxLength={300}
            onChange={(event) => setMaterialLabel(event.target.value)}
          />
          <textarea
            placeholder="或直接把材料文本粘贴到这里"
            value={materialContent}
            onChange={(event) => setMaterialContent(event.target.value)}
          />
          <input
            placeholder="可选：希望这份材料怎么用（例如：这是 JD，重点针对算法要求出题）"
            value={materialIntent}
            maxLength={2000}
            onChange={(event) => setMaterialIntent(event.target.value)}
          />
          {materialNotice && <p className="material-notice">{materialNotice}</p>}
          <button
            type="button"
            disabled={working !== '' || !materialLabel.trim() || !materialContent.trim()}
            onClick={() => void step('导入材料…', async () => {
              const label = materialLabel.trim();
              await window.mentalLegos.addScenarioMaterial({
                scenarioId: selected.id,
                label,
                content: materialContent.trim(),
                intent: materialIntent.trim(),
              });
              setMaterialLabel('');
              setMaterialContent('');
              setMaterialIntent('');
              setMaterialNotice(`✓ 「${label}」已导入。可以继续添加材料，或点击下方"生成针对性问题"。`);
            })}
          >
            授权并导入这份材料
          </button>
        </section>
    );

    const prepareSection = (
        <section className="scenario-block" key="prepare">
          <h3>事前准备</h3>
          {selected.analysis
            ? <p className="scenario-analysis">{selected.analysis}</p>
            : <p>还没有分析。导入材料后点击"生成针对性问题"。</p>}
          {costConfirm === 'prepare' ? (
            <>
              <p className="material-notice">
                材料共 {selected.materialCharacters.toLocaleString()} 字符，超出单次分析窗口
                （{AGENT_EXCERPT_CHARACTERS.toLocaleString()} 字符），只有靠前的内容会被分析；
                这次调用会实际消耗你的 API 用量。确认继续吗？
              </p>
              <div className="phase-actions">
                <button
                  type="button"
                  disabled={working !== '' || props.busy}
                  onClick={() => {
                    setCostConfirm(null);
                    void step('分析材料并生成问题…', () => (
                      window.mentalLegos.prepareScenario(selected.id)
                    ));
                  }}
                >
                  确认生成
                </button>
                <button type="button" className="quiet-button" onClick={() => setCostConfirm(null)}>
                  取消
                </button>
              </div>
            </>
          ) : (
            <button
              type="button"
              disabled={working !== '' || props.busy}
              onClick={() => {
                if (selected.materialCharacters > HIGH_COST_CONFIRM_CHARACTERS) {
                  setCostConfirm('prepare');
                  return;
                }
                void step('分析材料并生成问题…', () => (
                  window.mentalLegos.prepareScenario(selected.id)
                ));
              }}
            >
              {selected.preparedQuestions.length > 0 ? '重新生成问题' : '生成针对性问题'}
            </button>
          )}
          {selected.preparedQuestions.length > 0 && (
            <ol className="scenario-questions">
              {selected.preparedQuestions.map((question) => (
                <li key={question.id}>
                  <span className={question.answered ? 'question-done' : ''}>{question.prompt}</span>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={working !== '' || props.busy}
                    onClick={() => props.onOpenQuestion(selected.id, question.id)}
                  >
                    {question.answered ? '再练一次' : '训练这个问题'}
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>
    );

    const outlineSection = selected.type === 'speech' ? (
          <section className="scenario-block" key="outline">
            <h3>演讲骨架</h3>
            <p className="block-hint">
              把你积木库里的模块组装成这次演讲的骨架：开场钩子 → 要点（每个要点标注引用的模块）→
              收尾落点，并分配时间预算。核心观点只用你确认过的积木，缺的会标注【缺积木】提醒你先去训练。
            </p>
            <div className="phase-actions">
              <label className="outline-field">
                <span>时长（分钟）</span>
                <input
                  type="number"
                  min={1}
                  max={120}
                  value={outlineMinutes}
                  onChange={(event) => setOutlineMinutes(Math.max(1, Math.min(120, Number(event.target.value) || 1)))}
                />
              </label>
              <label className="outline-field outline-audience">
                <span>听众（可选）</span>
                <input
                  value={outlineAudience}
                  maxLength={400}
                  placeholder="例如：公司高管 / 技术团队 / 行业大会观众"
                  onChange={(event) => setOutlineAudience(event.target.value)}
                />
              </label>
              <button
                type="button"
                disabled={working !== '' || props.busy}
                onClick={() => void step('组装演讲骨架…', () => window.mentalLegos.composeSpeechOutline({
                  scenarioId: selected.id,
                  durationMinutes: outlineMinutes,
                  audience: outlineAudience.trim(),
                }))}
              >
                {selected.speechOutline ? '重新组装骨架' : '组装演讲骨架'}
              </button>
            </div>
            {selected.speechOutline && (
              <>
                <p className="scenario-analysis">{selected.speechOutline}</p>
                <div className="phase-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={working !== '' || props.busy}
                    onClick={() => void step('压缩骨架到一半时长…', () => window.mentalLegos.transformSpeechOutline({
                      scenarioId: selected.id, transform: 'compress', audience: '',
                    }))}
                  >
                    压缩到一半时长
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={working !== '' || props.busy}
                    onClick={() => void step('扩展骨架细节…', () => window.mentalLegos.transformSpeechOutline({
                      scenarioId: selected.id, transform: 'expand', audience: '',
                    }))}
                  >
                    扩展更多细节
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={working !== '' || props.busy || !outlineAudience.trim()}
                    title={outlineAudience.trim() ? '' : '先在上方"听众"里填写新的听众描述'}
                    onClick={() => void step('按新听众重构骨架…', () => window.mentalLegos.transformSpeechOutline({
                      scenarioId: selected.id, transform: 'audience', audience: outlineAudience.trim(),
                    }))}
                  >
                    换听众重构
                  </button>
                </div>
                <p className="block-hint">
                  变换会覆盖当前骨架（模块引用保持不变）。练习入口：下方"事前准备"生成的试讲任务，
                  每遍试讲都会给出时长、语速和停顿的实测反馈，可反复练到满意再提炼。
                </p>
              </>
            )}
          </section>
    ) : null;

    const reviewSection = (
        <section className="scenario-block" key="review">
          <h3>事后复盘</h3>
          <div className="phase-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={working !== ''}
              onClick={() => void step('解析文件…', async () => {
                const parsed = await window.mentalLegos.parseMaterialFile();
                if (!parsed) return;
                setReviewTranscript(parsed.text);
                setReviewNotice(parsed.warnings.length > 0
                  ? parsed.warnings.join(' ')
                  : `已从「${parsed.fileName}」提取转写文本，确认后开始复盘。`);
              })}
            >
              📄 从文件导入转写（PDF / Word / 文本）
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={working !== ''}
              onClick={() => audioInputRef.current?.click()}
            >
              🎧 导入录音并本地转写（wav / mp3 / m4a）
            </button>
            <input
              ref={audioInputRef}
              type="file"
              accept="audio/*,.m4a,.aac"
              style={{ display: 'none' }}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (!file) return;
                void step('本地转写录音（长录音需要几分钟）…', async () => {
                  const bytes = await file.arrayBuffer();
                  const decoded = await decodeAudioFileToWav(bytes);
                  const result = await window.mentalLegos.transcribeRecording(decoded.wav);
                  if (!result.text.trim()) {
                    setReviewNotice(`「${file.name}」转写结果为空——录音里可能没有清晰人声。`);
                    return;
                  }
                  setReviewTranscript((current) => (current ? `${current}\n${result.text}` : result.text));
                  setReviewNotice(`✓ 已本地转写「${file.name}」（${Math.round(result.audioDurationSeconds / 60)} 分钟音频），音频未离开本机。确认文本后开始复盘。`);
                });
              }}
            />
          </div>
          <textarea
            placeholder="或直接粘贴真实交流的转写或笔记（录音可先在训练页用语音转写）"
            value={reviewTranscript}
            onChange={(event) => setReviewTranscript(event.target.value)}
          />
          {reviewNotice && <p className="material-notice">{reviewNotice}</p>}
          <input
            placeholder="一句话结果备注（可选），例如：整体顺利，但证据被追问"
            value={reviewNote}
            maxLength={4000}
            onChange={(event) => setReviewNote(event.target.value)}
          />
          {costConfirm === 'review' && (
            <p className="material-notice">
              转写共 {reviewTranscript.trim().length.toLocaleString()} 字符，超出单次分析窗口
              （{AGENT_EXCERPT_CHARACTERS.toLocaleString()} 字符），只有靠前的内容会被复盘；
              这次调用会实际消耗你的 API 用量。确认继续吗？
            </p>
          )}
          <div className="phase-actions">
            <button
              type="button"
              disabled={working !== '' || props.busy || reviewTranscript.trim().length === 0}
              onClick={() => {
                const transcript = reviewTranscript.trim();
                if (costConfirm !== 'review' && transcript.length > HIGH_COST_CONFIRM_CHARACTERS) {
                  setCostConfirm('review');
                  return;
                }
                setCostConfirm(null);
                props.onReview({
                  scenarioId: selected.id,
                  transcript,
                  outcomeNote: reviewNote.trim(),
                });
                setReviewTranscript('');
                setReviewNote('');
                setReviewNotice(null);
              }}
            >
              {costConfirm === 'review' ? '确认复盘' : '开始复盘'}
            </button>
            {costConfirm === 'review' && (
              <button type="button" className="quiet-button" onClick={() => setCostConfirm(null)}>
                取消
              </button>
            )}
          </div>
        </section>
    );

    const dangerSection = (
        <section className="scenario-block scenario-danger" key="danger">
          <h3>删除场景</h3>
          {deletePreview ? (
            <>
              <p>
                将删除：材料 {deletePreview.sources} 份（含切段 {deletePreview.segments} 条）·
                问题 {deletePreview.questions} 道 · 回答记录 {deletePreview.attempts} 条 ·
                乐高库中属于本场景的模块 {deletePreview.scopedModules} 个。
              </p>
              <p className="block-hint">
                说明：场景模块保存在乐高库中，尚未提升为通用/专业的会随场景一并删除——
                要保留请先在乐高库中"提升"；已提升的全局模块不受影响
                {deletePreview.globalModuleReferences > 0
                  ? `（当前有 ${deletePreview.globalModuleReferences} 个引用了本场景的证据，仅证据链接会失效）`
                  : '（若其证据来自本场景，仅证据链接会失效）'}。
              </p>
              <div className="phase-actions">
                <button
                  type="button"
                  disabled={working !== ''}
                  onClick={() => void step('删除中…', async () => {
                    await window.mentalLegos.deleteScenario(selected.id);
                    setDeletePreview(null);
                    setSelectedId(null);
                  })}
                >
                  确认删除
                </button>
                <button type="button" className="quiet-button" onClick={() => setDeletePreview(null)}>
                  取消
                </button>
              </div>
            </>
          ) : (
            <button
              type="button"
              className="quiet-button"
              disabled={working !== ''}
              onClick={() => void step('计算删除影响…', async () => {
                setDeletePreview(await window.mentalLegos.previewScenarioDeletion(selected.id));
              })}
            >
              预览删除影响…
            </button>
          )}
        </section>
    );

    // The section order follows the workflow of each scenario type: a speech
    // starts from the skeleton, an interview/meeting starts from materials.
    const ordered = selected.type === 'speech'
      ? [outlineSection, prepareSection, materialSection, reviewSection]
      : [materialSection, prepareSection, reviewSection];

    return (
      <div className="scenario-view">
        <header className="chat-header">
          <button type="button" className="quiet-button" onClick={() => setSelectedId(null)}>← 场景列表</button>
          <span>{TYPE_LABELS[selected.type as ScenarioCreateInput['type']] ?? selected.type} · {selected.title}</span>
          <span />
        </header>
        {error && <p className="form-error">{error}</p>}
        {working && <BusyIndicator label={working} />}
        {ordered}
        {dangerSection}
      </div>
    );
  }

  return (
    <div className="scenario-view">
      <div className="section-heading">
        <h2 className="view-title">专项场景</h2>
        <button type="button" onClick={() => setShowCreate(true)}>创建场景</button>
      </div>
      {error && <p className="form-error">{error}</p>}
      {scenarios.length === 0 && (
        <p>还没有场景。为下一次重要交流创建一个——创建后就能导入 JD、简历等文件材料，生成针对性问题。</p>
      )}
      <div className="scenario-list">
        {scenarios.map((scenario) => (
          <button
            key={scenario.id}
            type="button"
            className="scenario-item"
            onClick={() => setSelectedId(scenario.id)}
          >
            <strong>{scenario.title}</strong>
            <span>
              {TYPE_LABELS[scenario.type as ScenarioCreateInput['type']] ?? scenario.type}
              · 材料 {scenario.materialCount} · 问题 {scenario.preparedQuestions.length}
              · 模块 {scenario.moduleCount}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
