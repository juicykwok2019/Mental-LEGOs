import { useState } from 'react';

import type {
  TrainingDueItem,
  TrainingHintLevel,
  TrainingTurnState,
} from '../shared/contracts';

// Chat-form daily training loop (Phase 1). Deliberately plain: the goal is to
// exercise the full gate → diagnosis → hints → second attempt → extraction →
// confirmation chain, not to design the final interface.

function messageFrom(reason: unknown): string {
  return reason instanceof Error ? reason.message : '发生了未知错误。';
}

const IDLE_STATE: TrainingTurnState = {
  sessionId: null,
  phase: 'idle',
  question: null,
  gate: null,
  transcript: [],
  candidates: [],
  committedCount: 0,
};

export function TrainingPanel() {
  const [turn, setTurn] = useState<TrainingTurnState>(IDLE_STATE);
  const [topic, setTopic] = useState('');
  const [draft, setDraft] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [due, setDue] = useState<TrainingDueItem[] | null>(null);

  async function step(label: string, work: () => Promise<TrainingTurnState>): Promise<void> {
    setBusy(true);
    setBusyLabel(label);
    setError(null);
    try {
      const next = await work();
      setTurn(next);
      setDraft('');
      setSelected(next.candidates.map((candidate) => candidate.id));
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setBusy(false);
      setBusyLabel('');
    }
  }

  async function loadDue(): Promise<void> {
    setError(null);
    try {
      setDue(await window.mentalLegos.getDueModules());
    } catch (reason) {
      setError(messageFrom(reason));
    }
  }

  const phase = turn.phase;

  return (
    <section className="workspace training-panel" aria-labelledby="training-heading">
      <div className="section-heading">
        <div>
          <p className="step-label">Phase 1 · 日常训练</p>
          <h2 id="training-heading">先答后辅助的训练闭环（Chat 验证形态）</h2>
        </div>
        <span className={`badge ${phase !== 'idle' ? 'badge-ready' : ''}`}>
          {phase === 'idle' ? '未开始' : `阶段：${phase}`}
        </span>
      </div>

      <p className="section-copy">
        流程：出题 → 第一遍独立回答（门禁保护，无任何提示）→ 证据化诊断 →
        按需逐级提示 → 第二遍回答 → 提炼语言乐高 → 你确认后写入正式库并安排复现。
        当前用文字代替语音，用于验证完整功能链路。
      </p>

      {turn.transcript.length > 0 && (
        <div className="chat-log" aria-live="polite">
          {turn.transcript.map((entry, index) => (
            <div key={index} className={`chat-entry chat-${entry.role}`}>
              <span className="chat-role">
                {entry.role === 'coach' ? '教练' : entry.role === 'user' ? '你' : '系统'}
              </span>
              <p>{entry.text}</p>
            </div>
          ))}
        </div>
      )}

      {phase === 'candidates-ready' && turn.candidates.length > 0 && (
        <div className="candidate-list">
          {turn.candidates.map((candidate) => (
            <label key={candidate.id} className="candidate-card">
              <input
                type="checkbox"
                checked={selected.includes(candidate.id)}
                onChange={(event) => {
                  setSelected(event.target.checked
                    ? [...selected, candidate.id]
                    : selected.filter((id) => id !== candidate.id));
                }}
              />
              <div>
                <strong>{candidate.title}</strong>
                <p>内核：{candidate.semanticKernel}</p>
                <p>骨架:{candidate.logicSkeleton.join(' → ')}</p>
                <p>外壳：{candidate.languageShells.join(' / ')}</p>
              </div>
            </label>
          ))}
        </div>
      )}

      <div className="training-actions">
        {(phase === 'idle' || phase === 'committed') && (
          <>
            <input
              className="topic-input"
              placeholder="可选：训练主题（如：跨团队协作）"
              value={topic}
              maxLength={200}
              onChange={(event) => setTopic(event.target.value)}
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => void step('正在出题…', () => (
                window.mentalLegos.startTraining({ topic })
              ))}
            >
              开始一次训练
            </button>
            <button type="button" className="secondary-button" disabled={busy} onClick={() => void loadDue()}>
              查看到期复现
            </button>
          </>
        )}

        {phase === 'first-attempt' && (
          <>
            <textarea
              className="response-input"
              placeholder="第一遍回答（先自己说，再把要点誊进来；也可以直接选择答不出来）"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button
              type="button"
              disabled={busy || draft.trim().length === 0}
              onClick={() => void step('封存第一遍…', () => window.mentalLegos.closeFirstAttempt({
                outcome: 'answered',
                responseText: draft.trim(),
              }))}
            >
              提交第一遍
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => void step('记录答不出来…', () => window.mentalLegos.closeFirstAttempt({
                outcome: 'cannot-answer',
                responseText: '',
              }))}
            >
              暂时答不出来
            </button>
          </>
        )}

        {phase === 'first-closed' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void step('正在诊断…', () => window.mentalLegos.requestDiagnosis())}
          >
            请求诊断
          </button>
        )}

        {phase === 'assistance' && (
          <>
            {turn.gate?.nextHintLevel && (
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => void step('获取提示…', () => (
                  window.mentalLegos.requestHint(turn.gate!.nextHintLevel as TrainingHintLevel)
                ))}
              >
                获取 {turn.gate.nextHintLevel} 提示
              </button>
            )}
            <textarea
              className="response-input"
              placeholder="第二遍回答"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button
              type="button"
              disabled={busy || draft.trim().length === 0}
              onClick={() => void step('记录第二遍…', () => window.mentalLegos.submitSecondAttempt({
                responseText: draft.trim(),
              }))}
            >
              提交第二遍
            </button>
          </>
        )}

        {phase === 'second-done' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void step('提炼候选模块…', () => window.mentalLegos.extractCandidates())}
          >
            提炼语言乐高
          </button>
        )}

        {phase === 'candidates-ready' && (
          <button
            type="button"
            disabled={busy || selected.length === 0}
            onClick={() => void step('确认写入…', () => window.mentalLegos.confirmCandidates({
              candidateIds: selected,
            }))}
          >
            确认选中的 {selected.length} 个模块
          </button>
        )}
      </div>

      {busy && <p className="training-busy">{busyLabel || '处理中…'}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}

      {due && (
        <div className="due-list">
          <strong>到期复现（{due.length}）</strong>
          {due.length === 0 && <p>暂无到期模块。</p>}
          {due.map((item) => (
            <p key={item.moduleId}>
              {item.title} · 阶段 {item.stage} · 到期 {item.dueAt ?? '未安排'}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
