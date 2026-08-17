import { useEffect, useRef, useState } from 'react';

import type {
  SpeechReadinessState,
  TrainingHintLevel,
  TrainingTurnState,
} from '../../shared/contracts';
import { VoiceRecorder } from '../recorder';
import { BusyIndicator } from '../components/BusyIndicator';

// The training conversation: coach/user bubbles, phase-driven actions, and a
// voice-first composer with text fallback. The renderer never decides state —
// it renders whatever turn state the host returns.

function messageFrom(reason: unknown): string {
  return reason instanceof Error ? reason.message : '发生了未知错误。';
}

export interface SpokenDraft {
  responseText: string;
  recordingId: string | null;
  durationMs: number | null;
  pauseCount: number | null;
  longestPauseMs: number | null;
}

interface ComposerProps {
  placeholder: string;
  submitLabel: string;
  disabled: boolean;
  speech: SpeechReadinessState | null;
  onSubmit(draft: SpokenDraft): void;
  onSpeechInstall(): void;
}

function Composer(props: ComposerProps) {
  const [text, setText] = useState('');
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [pauseCount, setPauseCount] = useState<number | null>(null);
  const [longestPauseMs, setLongestPauseMs] = useState<number | null>(null);
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);

  useEffect(() => () => {
    if (playbackUrl) URL.revokeObjectURL(playbackUrl);
  }, [playbackUrl]);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<VoiceRecorder | null>(null);

  async function toggleRecording(): Promise<void> {
    setError(null);
    try {
      if (!recording) {
        recorder.current = new VoiceRecorder();
        await recorder.current.start();
        setRecording(true);
        return;
      }
      const finished = await recorder.current!.stop();
      setRecording(false);
      setTranscribing(true);
      const result = await window.mentalLegos.transcribeRecording(finished.wav);
      setText((current) => (current ? `${current}\n${result.text}` : result.text));
      setRecordingId(result.recordingId);
      setDurationMs(finished.durationMs);
      setPauseCount(result.pauseCount);
      setLongestPauseMs(result.longestPauseMs);
      setPlaybackUrl(URL.createObjectURL(new Blob([finished.wav], { type: 'audio/wav' })));
    } catch (reason) {
      setRecording(false);
      setError(messageFrom(reason));
    } finally {
      setTranscribing(false);
    }
  }

  const speechReady = props.speech?.model === 'ready';

  return (
    <div className="composer">
      {error && <p className="form-error" role="alert">{error}</p>}
      {playbackUrl && (
        <div className="playback-row">
          <span>🔁 听一遍自己刚才的录音：</span>
          <audio controls src={playbackUrl} preload="metadata" />
        </div>
      )}
      <textarea
        value={text}
        placeholder={props.placeholder}
        disabled={props.disabled || transcribing}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="composer-actions">
        {speechReady ? (
          <button
            type="button"
            className={`mic-button ${recording ? 'mic-recording' : ''}`}
            disabled={props.disabled || transcribing}
            onClick={() => void toggleRecording()}
          >
            {recording ? '■ 停止并转写' : transcribing ? '转写中…' : '🎙 开始说话'}
          </button>
        ) : (
          <button
            type="button"
            className="secondary-button"
            disabled={props.disabled}
            onClick={props.onSpeechInstall}
            title={props.speech
              ? `下载本地语音模型（约 ${Math.ceil(props.speech.downloadBytes / 1024 / 1024)} MB）`
              : '正在检查本地语音模型'}
          >
            启用语音（下载本地模型）
          </button>
        )}
        <button
          type="button"
          disabled={props.disabled || transcribing || text.trim().length === 0}
          onClick={() => {
            props.onSubmit({ responseText: text.trim(), recordingId, durationMs, pauseCount, longestPauseMs });
            setText('');
            setRecordingId(null);
            setDurationMs(null);
            setPauseCount(null);
            setLongestPauseMs(null);
            setPlaybackUrl(null);
          }}
        >
          {props.submitLabel}
        </button>
      </div>
    </div>
  );
}

export interface ChatViewProps {
  turn: TrainingTurnState;
  busy: boolean;
  busyLabel: string;
  error: string | null;
  speech: SpeechReadinessState | null;
  onAction(label: string, work: () => Promise<TrainingTurnState>): void;
  onSpeechInstall(): void;
  onExit(): void;
}

interface CandidateDraft {
  title: string;
  kernel: string;
  skeletonText: string;
  shellsText: string;
}

export function ChatView(props: ChatViewProps) {
  const { turn, busy } = props;
  const logRef = useRef<HTMLDivElement | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, CandidateDraft>>({});

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [turn.transcript.length, busy]);

  useEffect(() => {
    setSelected(turn.candidates.map((candidate) => candidate.id));
    setEditingId(null);
    setDrafts({});
  }, [turn.candidates]);

  function draftFor(candidate: (typeof turn.candidates)[number]): CandidateDraft {
    return drafts[candidate.id] ?? {
      title: candidate.title,
      kernel: candidate.semanticKernel,
      skeletonText: candidate.logicSkeleton.join('\n'),
      shellsText: candidate.languageShells.join('\n'),
    };
  }

  function buildEdits(): Record<string, {
    title?: string; semanticKernel?: string; logicSkeleton?: string[]; languageShells?: string[];
  }> {
    const edits: Record<string, {
      title?: string; semanticKernel?: string; logicSkeleton?: string[]; languageShells?: string[];
    }> = {};
    for (const candidate of turn.candidates) {
      const draft = drafts[candidate.id];
      if (!draft) continue;
      const patch: (typeof edits)[string] = {};
      const title = draft.title.trim();
      const kernel = draft.kernel.trim();
      const skeleton = draft.skeletonText.split('\n').map((line) => line.trim()).filter(Boolean);
      const shells = draft.shellsText.split('\n').map((line) => line.trim()).filter(Boolean);
      if (title && title !== candidate.title) patch.title = title;
      if (kernel && kernel !== candidate.semanticKernel) patch.semanticKernel = kernel;
      if (skeleton.length > 0 && skeleton.join('\n') !== candidate.logicSkeleton.join('\n')) {
        patch.logicSkeleton = skeleton;
      }
      if (shells.length > 0 && shells.join('\n') !== candidate.languageShells.join('\n')) {
        patch.languageShells = shells;
      }
      if (Object.keys(patch).length > 0) edits[candidate.id] = patch;
    }
    return edits;
  }

  const phase = turn.phase;
  const api = window.mentalLegos;

  return (
    <div className="chat-view">
      <header className="chat-header">
        <button type="button" className="quiet-button" onClick={props.onExit}>← 返回</button>
        <span>
          {turn.mode === 'scenario' ? '专项场景训练' : turn.mode === 'speech' ? '演讲训练' : '日常开放训练'}
        </span>
        <span className="chat-phase">{busy ? props.busyLabel : ''}</span>
      </header>

      <div className="chat-log" ref={logRef}>
        {turn.transcript.map((entry, index) => (
          <div key={index} className={`bubble-row bubble-${entry.role}`}>
            <div className={`bubble bubble-kind-${entry.kind}`}>
              {entry.text}
            </div>
          </div>
        ))}

        {phase === 'candidates-ready' && turn.candidates.length > 0 && (
          <div className="bubble-row bubble-coach">
            <div className="bubble candidate-bubble">
              <p className="candidate-hint">
                勾选你认领的表达；措辞不满意可先"修改"再确认——入库的以你改过的为准。
              </p>
              {turn.candidates.map((candidate) => {
                const draft = draftFor(candidate);
                const edited = Boolean(drafts[candidate.id]);
                return editingId === candidate.id ? (
                  <div key={candidate.id} className="candidate-card candidate-editing">
                    <div className="candidate-edit-form">
                      <label>
                        <span>标题</span>
                        <input
                          value={draft.title}
                          maxLength={200}
                          onChange={(event) => setDrafts({
                            ...drafts, [candidate.id]: { ...draft, title: event.target.value },
                          })}
                        />
                      </label>
                      <label>
                        <span>语义内核（你想表达的核心判断）</span>
                        <textarea
                          value={draft.kernel}
                          onChange={(event) => setDrafts({
                            ...drafts, [candidate.id]: { ...draft, kernel: event.target.value },
                          })}
                        />
                      </label>
                      <label>
                        <span>逻辑骨架（每行一步）</span>
                        <textarea
                          value={draft.skeletonText}
                          onChange={(event) => setDrafts({
                            ...drafts, [candidate.id]: { ...draft, skeletonText: event.target.value },
                          })}
                        />
                      </label>
                      <label>
                        <span>语言外壳（每行一句你的原话）</span>
                        <textarea
                          value={draft.shellsText}
                          onChange={(event) => setDrafts({
                            ...drafts, [candidate.id]: { ...draft, shellsText: event.target.value },
                          })}
                        />
                      </label>
                      <div className="phase-actions">
                        <button type="button" className="secondary-button" onClick={() => setEditingId(null)}>
                          完成修改
                        </button>
                        <button
                          type="button"
                          className="quiet-button"
                          onClick={() => {
                            const { [candidate.id]: _dropped, ...rest } = drafts;
                            setDrafts(rest);
                            setEditingId(null);
                          }}
                        >
                          还原为提炼结果
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <label key={candidate.id} className="candidate-card">
                    <input
                      type="checkbox"
                      checked={selected.includes(candidate.id)}
                      onChange={(event) => setSelected(event.target.checked
                        ? [...selected, candidate.id]
                        : selected.filter((id) => id !== candidate.id))}
                    />
                    <div>
                      <strong>
                        {edited ? draft.title : candidate.title}
                        <em>
                          {candidate.domain === 'generic' ? ' · 通用'
                            : candidate.domain === 'professional' ? ' · 专业' : ' · 场景'}
                          {edited && ' · 已修改'}
                        </em>
                      </strong>
                      <p>内核：{edited ? draft.kernel : candidate.semanticKernel}</p>
                      <p>骨架：{(edited ? draft.skeletonText.split('\n').filter(Boolean) : candidate.logicSkeleton).join(' → ')}</p>
                      <p>外壳：{(edited ? draft.shellsText.split('\n').filter(Boolean) : candidate.languageShells).join(' / ')}</p>
                      <button
                        type="button"
                        className="quiet-button candidate-edit-button"
                        onClick={(event) => {
                          event.preventDefault();
                          setDrafts({ ...drafts, [candidate.id]: draft });
                          setEditingId(candidate.id);
                        }}
                      >
                        修改措辞
                      </button>
                    </div>
                  </label>
                );
              })}
              <button
                type="button"
                disabled={busy || selected.length === 0 || editingId !== null}
                onClick={() => props.onAction('确认写入…', () => api.confirmCandidates({
                  candidateIds: selected,
                  edits: buildEdits(),
                }))}
              >
                确认选中的 {selected.length} 个模块
              </button>
            </div>
          </div>
        )}

        {busy && (
          <div className="bubble-row bubble-coach">
            <div className="bubble candidate-bubble">
              <BusyIndicator label={props.busyLabel || '思考中…'} />
            </div>
          </div>
        )}
      </div>

      {props.error && <p className="form-error chat-error" role="alert">{props.error}</p>}

      <footer className="chat-footer">
        {phase === 'first-attempt' && (
          <>
            <Composer
              placeholder="先开口说，说完停止录音自动转写；也可以直接打字。"
              submitLabel="提交第一遍"
              disabled={busy}
              speech={props.speech}
              onSpeechInstall={props.onSpeechInstall}
              onSubmit={(draft) => props.onAction('封存第一遍…', () => api.closeFirstAttempt({
                outcome: 'answered',
                responseText: draft.responseText,
                recordingId: draft.recordingId,
                durationMs: draft.durationMs,
                pauseCount: draft.pauseCount,
                longestPauseMs: draft.longestPauseMs,
                openingDelayMs: null,
              }))}
            />
            <div className="phase-actions">
              <button
                type="button"
                className="quiet-button"
                disabled={busy}
                onClick={() => props.onAction('记录答不出来…', () => api.closeFirstAttempt({
                  outcome: 'cannot-answer', responseText: '', recordingId: null,
                  durationMs: null, pauseCount: null, longestPauseMs: null, openingDelayMs: null,
                }))}
              >
                暂时答不出来
              </button>
            </div>
          </>
        )}

        {phase === 'gap-query' && (
          <div className="phase-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => props.onAction('记录知识缺口…', () => api.resolveGap({ gap: 'knowledge' }))}
            >
              没想过这个问题（知识缺口）
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => props.onAction('进入表达训练…', () => api.resolveGap({ gap: 'expression' }))}
            >
              有想法但说不出来（表达缺口）
            </button>
          </div>
        )}

        {phase === 'first-closed' && (
          <>
            {turn.mode === 'speech' && (
              <Composer
                placeholder="🎙 再练一遍试讲——每一遍都会给出时长、语速和停顿的实测评估。"
                submitLabel="提交这一遍"
                disabled={busy}
                speech={props.speech}
                onSpeechInstall={props.onSpeechInstall}
                onSubmit={(draft) => props.onAction('记录这一遍试讲…', () => api.rehearseSpeech({
                  ...draft,
                }))}
              />
            )}
            <div className="phase-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => props.onAction('正在诊断…', () => api.requestDiagnosis())}
              >
                请求诊断
              </button>
            </div>
          </>
        )}

        {phase === 'assistance' && (
          <>
            <Composer
              placeholder="第二遍：结合诊断重新开口说一遍。"
              submitLabel="提交第二遍"
              disabled={busy}
              speech={props.speech}
              onSpeechInstall={props.onSpeechInstall}
              onSubmit={(draft) => props.onAction('记录第二遍…', () => api.submitSecondAttempt({
                ...draft,
              }))}
            />
            {turn.gate?.nextHintLevel && (
              <div className="phase-actions">
                <button
                  type="button"
                  className="quiet-button"
                  disabled={busy}
                  onClick={() => props.onAction('获取提示…', () => api.requestHint(
                    turn.gate!.nextHintLevel as TrainingHintLevel,
                  ))}
                >
                  还是卡住 → 要一个 {turn.gate.nextHintLevel} 提示
                </button>
              </div>
            )}
          </>
        )}

        {phase === 'second-done' && (
          <Composer
            placeholder={turn.mode === 'speech'
              ? '🎙 还想再练？直接开口——练到满意为止，每一遍都有实测评估。'
              : '还不满意可以再答一遍——每一遍都会得到对照上一遍的点评，练到满意再提炼。'}
            submitLabel="再练一遍"
            disabled={busy}
            speech={props.speech}
            onSpeechInstall={props.onSpeechInstall}
            onSubmit={(draft) => props.onAction(
              turn.mode === 'speech' ? '记录这一遍试讲…' : '点评这一遍的进步…',
              () => api.rehearseSpeech({ ...draft }),
            )}
          />
        )}

        {phase === 'second-done' && (
          <div className="phase-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => props.onAction('提炼候选模块…', () => api.extractCandidates())}
            >
              满意了，提炼语言乐高
            </button>
            {turn.mode !== 'open' && (
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => props.onAction('对方追问中…', () => api.askFollowUp())}
              >
                继续追问
              </button>
            )}
          </div>
        )}

        {phase === 'variation' && (
          <>
            <Composer
              placeholder="换了问法——直接开口回答，检验模块能否被调用。"
              submitLabel="提交变体回答"
              disabled={busy}
              speech={props.speech}
              onSpeechInstall={props.onSpeechInstall}
              onSubmit={(draft) => props.onAction('判定迁移…', () => api.answerVariation({
                ...draft,
              }))}
            />
            <div className="phase-actions">
              <button
                type="button"
                className="quiet-button"
                disabled={busy}
                onClick={() => props.onAction('跳过变体…', () => api.skipVariation())}
              >
                这次先跳过
              </button>
            </div>
          </>
        )}

        {phase === 'round-complete' && (
          <div className="phase-actions">
            <span className="round-complete-hint">本轮完成。</span>
            {turn.mode !== 'open' && (
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => props.onAction('对方追问中…', () => api.askFollowUp())}
              >
                继续追问
              </button>
            )}
            <button type="button" disabled={busy} onClick={props.onExit}>
              返回首页
            </button>
          </div>
        )}
      </footer>
    </div>
  );
}
