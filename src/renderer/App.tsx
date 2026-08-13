import { useEffect, useMemo, useState, type FormEvent } from 'react';

import type {
  AppInfo,
  ProviderSetupInput,
  ProviderSetupState,
} from '../shared/contracts';

function messageFrom(reason: unknown): string {
  return reason instanceof Error ? reason.message : '发生了未知错误。';
}

export function App() {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [setup, setSetup] = useState<ProviderSetupState | null>(null);
  const [providerId, setProviderId] = useState<ProviderSetupInput['providerId']>('anthropic');
  const [displayName, setDisplayName] = useState('Anthropic');
  const [baseUrl, setBaseUrl] = useState('https://api.anthropic.com');
  const [model, setModel] = useState('claude-sonnet-5');
  const [storage, setStorage] = useState<ProviderSetupInput['storage']>('session');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      window.mentalLegos.getAppInfo(),
      window.mentalLegos.getProviderSetup(),
    ]).then(async ([info, providerSetup]) => {
      setAppInfo(info);
      setSetup(providerSetup);
      await window.mentalLegos.reportReady();
    }).catch((reason: unknown) => {
      setError(messageFrom(reason));
    });
  }, []);

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

        {(notice || error) && (
          <div className={`notice ${error ? 'notice-error' : ''}`} role="status">
            {error ?? notice}
          </div>
        )}
      </section>
    </main>
  );
}
