import { useEffect, useState } from 'react';

import {
  AGENT_EXCERPT_CHARACTERS,
  HIGH_COST_CONFIRM_CHARACTERS,
  type ScenarioCreateInput,
  type ScenarioDeletePreview,
  type ScenarioSummary,
} from '../../shared/contracts';
import { BusyIndicator } from '../components/BusyIndicator';

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
    return (
      <div className="scenario-view">
        <header className="chat-header">
          <button type="button" className="quiet-button" onClick={() => setSelectedId(null)}>← 场景列表</button>
          <span>{TYPE_LABELS[selected.type as ScenarioCreateInput['type']] ?? selected.type} · {selected.title}</span>
          <span />
        </header>
        {error && <p className="form-error">{error}</p>}
        {working && <BusyIndicator label={working} />}

        <section className="scenario-block">
          <h3>材料（{selected.materialCount}）</h3>
          {selected.materials.length > 0 && (
            <ul className="version-list">
              {selected.materials.map((material) => (
                <li key={material.id}>
                  <span>
                    {material.label} · {material.characters.toLocaleString()} 字符 ·{' '}
                    {material.addedAt.slice(0, 10)}
                    {material.intent && <em className="material-intent">期望：{material.intent}</em>}
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
                    <button
                      type="button"
                      className="quiet-button"
                      disabled={working !== ''}
                      onClick={() => setMaterialToDelete(material.id)}
                    >
                      删除
                    </button>
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

        <section className="scenario-block">
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

        <section className="scenario-block">
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

        <section className="scenario-block scenario-danger">
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
