import { useEffect, useState } from 'react';

import type {
  AppInfo,
  ProfileSeedInput,
  ProfileState,
  SpeechReadinessState,
  TrainingTurnState,
} from '../shared/contracts';
import { AboutView } from './views/AboutView';
import { BusyIndicator } from './components/BusyIndicator';
import { ChatView } from './views/ChatView';
import { FoundationView } from './views/FoundationView';
import { HomeView } from './views/HomeView';
import { LibraryView } from './views/LibraryView';
import { ScenariosView } from './views/ScenariosView';
import { SettingsView } from './views/SettingsView';

// Application shell: two primary actions (open practice / scenarios), the
// module library, and settings. Training itself always runs in the chat view.

type View = 'home' | 'chat' | 'scenarios' | 'library' | 'foundation' | 'settings' | 'about';

function messageFrom(reason: unknown): string {
  return reason instanceof Error ? reason.message : '发生了未知错误。';
}

const EMPTY_SEED: ProfileSeedInput = {
  direction: '', currentWork: '', targetScenarios: '', material: '',
};

function ProfileOnboarding(props: {
  initial: ProfileSeedInput | null;
  onSaved(profile: ProfileState): void;
  onCancel: (() => void) | null;
}) {
  const [seed, setSeed] = useState<ProfileSeedInput>(props.initial ?? EMPTY_SEED);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showRestore, setShowRestore] = useState(false);
  const [restorePassword, setRestorePassword] = useState('');

  return (
    <div className="onboarding">
      <h2>三句话，让出题落在你的专业上</h2>
      <p className="section-copy">
        不用填长表格。画像会随着每次训练自动成长；这里只需要一个起点。
      </p>
      <label>
        <span>1. 一句话说明你的职业方向 *</span>
        <input
          value={seed.direction}
          maxLength={2000}
          placeholder="例如：AI 产品负责人，关注大模型在传统企业的落地"
          onChange={(event) => setSeed({ ...seed, direction: event.target.value })}
        />
      </label>
      <label>
        <span>2. 最近在做什么</span>
        <input
          value={seed.currentWork}
          maxLength={4000}
          placeholder="例如：推进一个跨部门的智能客服项目"
          onChange={(event) => setSeed({ ...seed, currentWork: event.target.value })}
        />
      </label>
      <label>
        <span>3. 想练哪些场景</span>
        <input
          value={seed.targetScenarios}
          maxLength={4000}
          placeholder="例如：高管汇报、客户方案沟通、面试"
          onChange={(event) => setSeed({ ...seed, targetScenarios: event.target.value })}
        />
      </label>
      <label>
        <span>可选：粘贴一段简历、项目介绍或你的观点（留在本机，加密存储）</span>
        <textarea
          value={seed.material}
          onChange={(event) => setSeed({ ...seed, material: event.target.value })}
        />
      </label>
      <button
        type="button"
        className="secondary-button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          window.mentalLegos.parseMaterialFile().then((parsed) => {
            if (!parsed) return;
            // Profile seed material caps at 200k characters (profileSeedInputSchema).
            const limit = 200_000;
            setSeed((current) => ({ ...current, material: parsed.text.slice(0, limit) }));
            const messages = [`已从「${parsed.fileName}」提取文本，确认内容无误后保存。`, ...parsed.warnings];
            if (parsed.text.length > limit) messages.push('内容超过画像材料上限，已截断。');
            setNotice(messages.join(' '));
          }).catch((reason: unknown) => {
            setError(messageFrom(reason));
          }).finally(() => setBusy(false));
        }}
      >
        从文件导入（PDF / Word / 文本）
      </button>
      {notice && <p className="material-notice">{notice}</p>}
      {error && <p className="form-error">{error}</p>}
      <div className="phase-actions">
        <button
          type="button"
          disabled={busy || seed.direction.trim().length === 0}
          onClick={() => {
            setBusy(true);
            setError(null);
            window.mentalLegos.saveProfile({
              ...seed,
              direction: seed.direction.trim(),
            }).then(props.onSaved).catch((reason: unknown) => {
              setError(messageFrom(reason));
            }).finally(() => setBusy(false));
          }}
        >
          保存并开始
        </button>
        {props.onCancel && (
          <button type="button" className="quiet-button" onClick={props.onCancel}>取消</button>
        )}
      </div>

      {!props.initial && (
        <div className="restore-block">
          {showRestore ? (
            <>
              <p className="block-hint">
                换设备迁移：选择在旧设备上导出的 .mlexport 加密备份，输入当时设置的口令。
                恢复只能在全新安装时进行（这台设备还没有任何训练数据）。
              </p>
              <div className="phase-actions">
                <input
                  type="password"
                  placeholder="备份口令（至少 8 位）"
                  value={restorePassword}
                  minLength={8}
                  maxLength={200}
                  onChange={(event) => setRestorePassword(event.target.value)}
                />
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy || restorePassword.length < 8}
                  onClick={() => {
                    setBusy(true);
                    setError(null);
                    window.mentalLegos.importBackup(restorePassword).then((result) => {
                      if (!result.restored) return;
                      setNotice(`✓ 已从「${result.fileName}」恢复 ${result.moduleCount} 个模块及全部训练数据。正在进入应用…`);
                      return window.mentalLegos.getProfile().then(props.onSaved);
                    }).catch((reason: unknown) => {
                      setError(messageFrom(reason));
                    }).finally(() => setBusy(false));
                  }}
                >
                  选择备份文件并恢复
                </button>
                <button type="button" className="quiet-button" onClick={() => setShowRestore(false)}>
                  取消
                </button>
              </div>
            </>
          ) : (
            <button type="button" className="quiet-button" onClick={() => setShowRestore(true)}>
              从旧设备的加密备份恢复 →
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function App() {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [view, setView] = useState<View>('home');
  const [profile, setProfile] = useState<ProfileState | null>(null);
  const [editingProfile, setEditingProfile] = useState(false);
  const [creatingScenario, setCreatingScenario] = useState(false);
  const [speech, setSpeech] = useState<SpeechReadinessState | null>(null);
  const [turn, setTurn] = useState<TrainingTurnState | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      window.mentalLegos.getAppInfo(),
      window.mentalLegos.getProfile(),
      window.mentalLegos.getSpeechReadiness().catch(() => null),
      window.mentalLegos.getTrainingState().catch(() => null),
    ]).then(async ([info, profileState, speechState, trainingState]) => {
      setAppInfo(info);
      setProfile(profileState);
      setSpeech(speechState);
      if (trainingState && trainingState.phase !== 'idle') {
        // A renderer reload must not orphan a session that the host still holds.
        setTurn(trainingState);
        setView('chat');
      }
      await window.mentalLegos.reportReady();
    }).catch((reason: unknown) => {
      setError(messageFrom(reason));
    });
  }, []);

  function runStep(label: string, work: () => Promise<TrainingTurnState>): void {
    setBusy(true);
    setBusyLabel(label);
    setError(null);
    work().then((next) => {
      setTurn(next);
      setView('chat');
    }).catch((reason: unknown) => {
      setError(messageFrom(reason));
    }).finally(() => {
      setBusy(false);
      setBusyLabel('');
    });
  }

  async function installSpeech(): Promise<void> {
    setError(null);
    setBusy(true);
    setBusyLabel('正在下载本地语音模型…');
    try {
      setSpeech(await window.mentalLegos.installSpeechModel());
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setBusy(false);
      setBusyLabel('');
    }
  }

  const needsOnboarding = profile !== null && profile.seed === null;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">心智乐高 · 不再从零思考表达，拼装你的认知积木</p>
          <h1>Mental LEGOs</h1>
        </div>
        <nav className="main-nav">
          {([
            ['home', '今天练'],
            ['scenarios', '场景'],
            ['library', '积木库'],
            ['foundation', '个人底座'],
            ['settings', '设置'],
          ] as Array<[View, string]>).map(([target, label]) => (
            <button
              key={target}
              type="button"
              className={view === target ? 'nav-active' : ''}
              onClick={() => setView(target)}
            >
              {label}
            </button>
          ))}
          {turn && turn.phase !== 'idle' && (
            <button
              type="button"
              className={view === 'chat' ? 'nav-active nav-training' : 'nav-training'}
              onClick={() => setView('chat')}
            >
              ● 训练中
            </button>
          )}
        </nav>
        <div className="runtime-status">
          <span className="status-dot" aria-hidden="true" />
          {appInfo ? appInfo.version : '启动中…'}
        </div>
      </header>

      {error && view !== 'chat' && <p className="form-error shell-error" role="alert">{error}</p>}

      {turn && turn.phase !== 'idle' && view !== 'chat' && !needsOnboarding && !editingProfile && (
        <div className="resume-strip">
          <span>有一场训练正在进行——切换页面不会丢失，随时回去接着练。</span>
          <button type="button" onClick={() => setView('chat')}>继续训练</button>
        </div>
      )}

      {needsOnboarding || editingProfile ? (
        <ProfileOnboarding
          initial={profile?.seed ?? null}
          onSaved={(next) => {
            setProfile(next);
            setEditingProfile(false);
          }}
          onCancel={editingProfile ? () => setEditingProfile(false) : null}
        />
      ) : view === 'chat' && turn ? (
        <ChatView
          turn={turn}
          busy={busy}
          busyLabel={busyLabel}
          error={error}
          speech={speech}
          onSpeechInstall={() => void installSpeech()}
          onAction={(label, work) => runStep(label, work)}
          onExit={() => {
            setTurn(null);
            setError(null);
            window.mentalLegos.getProfile().then(setProfile).catch(() => undefined);
            setView('home');
          }}
        />
      ) : view === 'scenarios' ? (
        <ScenariosView
          busy={busy}
          creating={creatingScenario}
          onCloseCreate={() => setCreatingScenario(false)}
          onOpenQuestion={(scenarioId, questionId) => {
            runStep('进入场景问答…', () => (
              window.mentalLegos.startScenarioQuestion(scenarioId, questionId)
            ));
          }}
          onReview={(input) => {
            runStep('复盘分析中…', () => window.mentalLegos.reviewScenario(input));
          }}
        />
      ) : view === 'library' ? (
        <LibraryView />
      ) : view === 'foundation' ? (
        <FoundationView onEditProfile={() => setEditingProfile(true)} />
      ) : view === 'settings' ? (
        <SettingsView />
      ) : view === 'about' ? (
        <AboutView onBack={() => setView('home')} />
      ) : profile ? (
        <HomeView
          profile={profile}
          busy={busy}
          onOpenAbout={() => setView('about')}
          onEditProfile={() => setEditingProfile(true)}
          onCreateScenario={() => {
            setCreatingScenario(true);
            setView('scenarios');
          }}
          onStartOpenPractice={(topic) => {
            runStep('正在基于你的画像出题…', () => window.mentalLegos.startTraining({
              topic, scenarioId: null, questionId: null,
            }));
          }}
        />
      ) : (
        <p className="section-copy">加载中…</p>
      )}

      {busy && view !== 'chat' && (
        <div className="shell-busy"><BusyIndicator label={busyLabel || '处理中…'} /></div>
      )}
    </main>
  );
}
