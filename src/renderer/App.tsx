import { useEffect, useMemo, useState, type FormEvent } from 'react';

import type {
  AgentReadinessState,
  AppInfo,
  ProviderCertificationDraft,
  ProviderCertificationResult,
  ProviderSetupInput,
  ProviderSetupState,
} from '../shared/contracts';

function messageFrom(reason: unknown): string {
  return reason instanceof Error ? reason.message : '发生了未知错误。';
}

export function App() {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [setup, setSetup] = useState<ProviderSetupState | null>(null);
  const [readiness, setReadiness] = useState<AgentReadinessState | null>(null);
  const [providerId, setProviderId] = useState<ProviderSetupInput['providerId']>('anthropic');
  const [displayName, setDisplayName] = useState('Anthropic');
  const [baseUrl, setBaseUrl] = useState('https://api.anthropic.com');
  const [model, setModel] = useState('claude-sonnet-5');
  const [storage, setStorage] = useState<ProviderSetupInput['storage']>('session');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [certificationBusy, setCertificationBusy] = useState(false);
  const [certificationDraft, setCertificationDraft] = useState<ProviderCertificationDraft | null>(null);
  const [certificationResult, setCertificationResult] = useState<ProviderCertificationResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      window.mentalLegos.getAppInfo(),
      window.mentalLegos.getProviderSetup(),
      window.mentalLegos.getAgentReadiness(),
    ]).then(async ([info, providerSetup, agentReadiness]) => {
      setAppInfo(info);
      setSetup(providerSetup);
      setReadiness(agentReadiness);
      await window.mentalLegos.reportReady();
    }).catch((reason: unknown) => {
      setError(messageFrom(reason));
    });
  }, []);

  useEffect(() => {
    if (readiness?.agentRuntime !== 'checking') return undefined;
    const timer = window.setTimeout(() => {
      window.mentalLegos.getAgentReadiness()
        .then(setReadiness)
        .catch((reason: unknown) => setError(messageFrom(reason)));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [readiness?.agentRuntime]);

  const selectedPreset = useMemo(
    () => setup?.providers.find((provider) => provider.id === providerId),
    [providerId, setup],
  );

  function selectProvider(value: ProviderSetupInput['providerId']): void {
    setProviderId(value);
    const preset = setup?.providers.find((provider) => provider.id === value);
    if (preset) {
      setDisplayName(preset.displayName);
      setBaseUrl(preset.baseUrl);
      setModel(preset.recommendedModels[0] ?? '');
    } else {
      setDisplayName('自定义 Anthropic 兼容服务');
      setBaseUrl('https://');
      setModel('');
    }
    setNotice(null);
    setError(null);
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const next = await window.mentalLegos.saveProviderSetup({
        providerId,
        displayName,
        baseUrl,
        model,
        storage,
        apiKey,
      });
      setSetup(next);
      setApiKey('');
      setNotice('配置已保存。应用不会显示或回读完整密钥。');
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setBusy(false);
    }
  }

  async function clear(): Promise<void> {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      setSetup(await window.mentalLegos.clearProviderSetup());
      setApiKey('');
      setNotice('配置与对应密钥已从本机删除。');
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setBusy(false);
    }
  }

  async function installRuntime(): Promise<void> {
    setRuntimeBusy(true);
    setNotice('正在下载并校验隔离的 Bash / Python 运行时，请勿关闭应用…');
    setError(null);
    try {
      setReadiness(await window.mentalLegos.installBashRuntime());
      setNotice('Bash / Python 运行时已完成哈希校验，可以执行完整 Agent 认证。');
    } catch (reason) {
      setError(messageFrom(reason));
      setNotice(null);
    } finally {
      setRuntimeBusy(false);
    }
  }

  async function startCertification(): Promise<void> {
    setCertificationBusy(true);
    setCertificationDraft(null);
    setCertificationResult(null);
    setNotice('核心 Agent 正在执行 Skill、原生工具、隔离 Python 与 MCP 认证…');
    setError(null);
    try {
      setCertificationDraft(await window.mentalLegos.startProviderCertification());
      setNotice(null);
    } catch (reason) {
      setError(messageFrom(reason));
      setNotice(null);
    } finally {
      setCertificationBusy(false);
    }
  }

  async function confirmCertification(): Promise<void> {
    if (!certificationDraft) return;
    setCertificationBusy(true);
    setNotice('正在签发一次性确认 token，并恢复同一个 Agent 会话…');
    setError(null);
    try {
      const result = await window.mentalLegos.confirmProviderCertification(
        certificationDraft.certificationId,
      );
      setCertificationResult(result);
      setCertificationDraft(null);
      setNotice('完整 Provider 能力认证已通过，合成测试数据已清理。');
    } catch (reason) {
      setCertificationDraft(null);
      setError(messageFrom(reason));
      setNotice(null);
    } finally {
      setCertificationBusy(false);
    }
  }

  async function cancelCertification(): Promise<void> {
    if (!certificationDraft) return;
    setCertificationBusy(true);
    setError(null);
    try {
      await window.mentalLegos.cancelProviderCertification(
        certificationDraft.certificationId,
      );
      setCertificationDraft(null);
      setNotice('认证已取消，合成候选和临时工作区已清理。');
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setCertificationBusy(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Phase 0 · 架构验证</p>
          <h1>Mental LEGOs</h1>
        </div>
        <div className="runtime-status" aria-live="polite">
          <span className="status-dot" aria-hidden="true" />
          {appInfo
            ? `${appInfo.version} · 安全桌面运行时就绪`
            : '正在验证桌面运行时…'}
        </div>
      </header>

      <section className="intro">
        <p>先回答，再辅助。把真实表达提炼成可被大脑快速调用、灵活拼装的语言乐高。</p>
      </section>

      <section className="runtime-card" aria-labelledby="runtime-heading">
        <div>
          <p className="step-label">架构验证 00</p>
          <h2 id="runtime-heading">本地 Agent 能力运行时</h2>
          <p>
            Claude Agent SDK、隔离沙箱与内置 Skill 随应用提供；Bash、Coreutils 和
            Python 首次使用时下载到本机并逐文件校验。
          </p>
        </div>
        <div className="runtime-actions">
          <span className={`badge ${readiness?.agentRuntime === 'ready' ? 'badge-ready' : ''}`}>
            Agent {readiness?.agentRuntime === 'ready'
              ? '就绪'
              : readiness?.agentRuntime === 'error' ? '异常' : '检查中'}
          </span>
          <span className={`badge ${readiness?.bashRuntime === 'ready' ? 'badge-ready' : ''}`}>
            Bash / Python {readiness?.bashRuntime === 'ready' ? '就绪' : '未安装'}
          </span>
          {readiness && readiness.bashRuntime !== 'ready' && (
            <button
              className="secondary-button"
              type="button"
              disabled={runtimeBusy}
              onClick={() => void installRuntime()}
            >
              {runtimeBusy
                ? '正在准备…'
                : `下载并校验（约 ${Math.ceil(readiness.downloadBytes / 1024 / 1024)} MB）`}
            </button>
          )}
        </div>
      </section>

      <section className="workspace" aria-labelledby="provider-heading">
        <div className="section-heading">
          <div>
            <p className="step-label">架构验证 01</p>
            <h2 id="provider-heading">连接你的核心 Agent</h2>
          </div>
          <span className={`badge ${setup?.configured ? 'badge-ready' : ''}`}>
            {setup?.configured ? '已配置' : '待配置'}
          </span>
        </div>

        <p className="section-copy">
          只支持 Anthropic Messages 兼容端点。密钥经受限 IPC 一次性送入主进程；
          界面、Agent 工作区、日志和 Git 都不会保存明文。
        </p>

        {setup?.configured && (
          <aside className="configured-card" aria-label="当前模型配置">
            <div>
              <strong>{setup.configured.displayName}</strong>
              <span>{setup.configured.model}</span>
            </div>
            <div>
              <span>{setup.configured.baseUrl}</span>
              <span>
                {setup.configured.credentialHint} ·{' '}
                {setup.configured.storage === 'windows'
                  ? 'Windows 凭据管理器'
                  : '仅本次会话'}
              </span>
            </div>
            <button className="quiet-button" type="button" disabled={busy} onClick={() => void clear()}>
              删除配置
            </button>
          </aside>
        )}

        <form className="provider-form" onSubmit={(event) => void save(event)}>
          <label>
            <span>服务商</span>
            <select
              value={providerId}
              onChange={(event) => selectProvider(event.target.value as ProviderSetupInput['providerId'])}
            >
              {setup?.providers.map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.displayName}</option>
              ))}
              <option value="custom">自定义 Anthropic 兼容服务</option>
            </select>
          </label>

          <label>
            <span>配置名称</span>
            <input
              value={displayName}
              maxLength={80}
              required
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>

          <label className="wide-field">
            <span>Base URL</span>
            <input
              value={baseUrl}
              inputMode="url"
              required
              spellCheck={false}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
            <small>必须使用 HTTPS，不能包含密钥、查询参数或本机/内网地址。</small>
          </label>

          <label>
            <span>模型</span>
            <input
              value={model}
              list="recommended-models"
              maxLength={120}
              required
              spellCheck={false}
              onChange={(event) => setModel(event.target.value)}
            />
            <datalist id="recommended-models">
              {selectedPreset?.recommendedModels.map((value) => (
                <option key={value} value={value} />
              ))}
            </datalist>
          </label>

          <fieldset>
            <legend>密钥保存方式</legend>
            <label className="radio-line">
              <input
                type="radio"
                name="storage"
                value="session"
                checked={storage === 'session'}
                onChange={() => setStorage('session')}
              />
              仅本次会话
            </label>
            <label className="radio-line">
              <input
                type="radio"
                name="storage"
                value="windows"
                checked={storage === 'windows'}
                onChange={() => setStorage('windows')}
              />
              Windows 凭据管理器
            </label>
          </fieldset>

          <label className="wide-field">
            <span>API Key</span>
            <input
              type="password"
              value={apiKey}
              autoComplete="new-password"
              maxLength={2560}
              required
              spellCheck={false}
              onChange={(event) => setApiKey(event.target.value)}
            />
            <small>请只在此处输入真实密钥，不要发到聊天、终端或提交到仓库。</small>
          </label>

          <div className="form-actions wide-field">
            <button className="primary-button" type="submit" disabled={busy || !setup}>
              {busy ? '正在安全保存…' : setup?.configured ? '替换配置' : '安全保存配置'}
            </button>
            <span className="source-note">
              {selectedPreset
                ? '端点来自服务商官方文档，完整能力仍需实测。'
                : '自定义端点会被标记为未认证。'}
            </span>
          </div>
        </form>

        <div className="certification-panel">
          <div>
            <p className="step-label">架构验证 02</p>
            <h3>完整 Provider 能力认证</h3>
            <p>
              认证会向当前服务商发送纯合成测试内容，可能产生少量 API 费用；不会发送你的
              简历、JD、录音、画像或语言模块。
            </p>
          </div>
          {!certificationDraft && !certificationResult && (
            <button
              className="primary-button"
              type="button"
              disabled={
                certificationBusy
                || !setup?.configured
                || readiness?.agentRuntime !== 'ready'
                || readiness.bashRuntime !== 'ready'
              }
              onClick={() => void startCertification()}
            >
              {certificationBusy ? 'Agent 正在认证…' : '运行完整能力认证'}
            </button>
          )}

          {certificationDraft && (
            <div className="certification-preview">
              <div className="preview-heading">
                <strong>确认写入这个临时合成模块？</strong>
                <span>{certificationDraft.providerName} · {certificationDraft.model}</span>
              </div>
              <dl>
                <div><dt>语义内核</dt><dd>{certificationDraft.candidate.semanticCore}</dd></div>
                <div><dt>逻辑骨架</dt><dd>{certificationDraft.candidate.logicalSkeleton}</dd></div>
                <div><dt>语言外壳</dt><dd>{certificationDraft.candidate.languageShell}</dd></div>
                <div><dt>作用域</dt><dd>仅认证会话，完成后清除</dd></div>
              </dl>
              <div className="check-grid">
                {certificationDraft.checks.map((check) => (
                  <span key={check.id}>✓ {check.label}</span>
                ))}
              </div>
              <div className="preview-actions">
                <button
                  className="primary-button"
                  type="button"
                  disabled={certificationBusy}
                  onClick={() => void confirmCertification()}
                >
                  {certificationBusy ? '正在确认并恢复…' : '确认预览并完成认证'}
                </button>
                <button
                  className="quiet-button"
                  type="button"
                  disabled={certificationBusy}
                  onClick={() => void cancelCertification()}
                >
                  取消并清理
                </button>
              </div>
            </div>
          )}

          {certificationResult && (
            <div className="certification-success" role="status">
              <strong>认证通过</strong>
              <span>{certificationResult.providerName} · {certificationResult.model}</span>
              <div className="check-grid">
                {certificationResult.checks.map((check) => (
                  <span key={check.id}>✓ {check.label}</span>
                ))}
              </div>
            </div>
          )}
        </div>

        {(notice || error) && (
          <div className={`notice ${error ? 'notice-error' : ''}`} role="status">
            {error ?? notice}
          </div>
        )}
      </section>
    </main>
  );
}
