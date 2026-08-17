import { useEffect, useState } from 'react';

import type {
  ScenarioCreateInput,
  ScenarioDeletePreview,
  ScenarioSummary,
} from '../../shared/contracts';

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
  const [reviewTranscript, setReviewTranscript] = useState('');
  const [reviewNote, setReviewNote] = useState('');
  const [deletePreview, setDeletePreview] = useState<ScenarioDeletePreview | null>(null);

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
        <h2>创建专项场景</h2>
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
        {working && <p className="training-busy">{working}</p>}

        <section className="scenario-block">
          <h3>材料（{selected.materialCount}）</h3>
          <input
            placeholder="材料名称，例如：JD / 我的简历 / 方案摘要"
            value={materialLabel}
            maxLength={300}
            onChange={(event) => setMaterialLabel(event.target.value)}
          />
          <textarea
            placeholder="粘贴材料文本（支持任意长度文本；文件请先复制内容粘贴）"
            value={materialContent}
            onChange={(event) => setMaterialContent(event.target.value)}
          />
          <button
            type="button"
            disabled={working !== '' || !materialLabel.trim() || !materialContent.trim()}
            onClick={() => void step('导入材料…', async () => {
              await window.mentalLegos.addScenarioMaterial({
                scenarioId: selected.id,
                label: materialLabel.trim(),
                content: materialContent.trim(),
              });
              setMaterialLabel('');
              setMaterialContent('');
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
          <button
            type="button"
            disabled={working !== '' || props.busy}
            onClick={() => void step('分析材料并生成问题…', () => (
              window.mentalLegos.prepareScenario(selected.id)
            ))}
          >
            {selected.preparedQuestions.length > 0 ? '重新生成问题' : '生成针对性问题'}
          </button>
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
          <textarea
            placeholder="粘贴真实交流的转写或笔记（录音可先在训练页用语音转写）"
            value={reviewTranscript}
            onChange={(event) => setReviewTranscript(event.target.value)}
          />
          <input
            placeholder="一句话结果备注（可选），例如：整体顺利，但证据被追问"
            value={reviewNote}
            maxLength={4000}
            onChange={(event) => setReviewNote(event.target.value)}
          />
          <button
            type="button"
            disabled={working !== '' || props.busy || reviewTranscript.trim().length === 0}
            onClick={() => {
              props.onReview({
                scenarioId: selected.id,
                transcript: reviewTranscript.trim(),
                outcomeNote: reviewNote.trim(),
              });
              setReviewTranscript('');
              setReviewNote('');
            }}
          >
            开始复盘
          </button>
        </section>

        <section className="scenario-block scenario-danger">
          <h3>删除场景</h3>
          {deletePreview ? (
            <>
              <p>
                将删除：材料 {deletePreview.sources} · 片段 {deletePreview.segments} ·
                问题 {deletePreview.questions} · 回答 {deletePreview.attempts} ·
                场景模块 {deletePreview.scopedModules}；
                {deletePreview.globalModuleReferences > 0
                  && ` ${deletePreview.globalModuleReferences} 个全局模块引用了这里的证据（模块保留）。`}
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
        <h2>专项场景</h2>
        <button type="button" onClick={() => setShowCreate(true)}>创建场景</button>
      </div>
      {error && <p className="form-error">{error}</p>}
      {scenarios.length === 0 && <p>还没有场景。为下一次重要交流创建一个。</p>}
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
