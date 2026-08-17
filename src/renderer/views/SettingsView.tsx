import { useEffect, useMemo, useState, type FormEvent } from 'react';

import type {
  AgentReadinessState,
  PrivacyOverview,
  ProviderCertificationDraft,
  ProviderCertificationResult,
  ProviderSetupInput,
  ProviderSetupState,
  SpeechReadinessState,
} from '../../shared/contracts';

function messageFrom(reason: unknown): string {
  return reason instanceof Error ? reason.message : '发生了未知错误。';
}

function protocolLabel(protocol: 'anthropic-messages' | 'openai-chat-completions'): string {
  return protocol === 'anthropic-messages'
    ? 'Anthropic Messages 直连'
    : 'OpenAI Chat Completions · 本地安全转换';
}

export function SettingsView() {
  const [setup, setSetup] = useState<ProviderSetupState | null>(null);
  const [readiness, setReadiness] = useState<AgentReadinessState | null>(null);
  const [speech, setSpeech] = useState<SpeechReadinessState | null>(null);
  const [speechBusy, setSpeechBusy] = useState(false);
  const [privacy, setPrivacy] = useState<PrivacyOverview | null>(null);
  const [exportPassword, setExportPassword] = useState('');
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
      window.mentalLegos.getProviderSetup(),
      window.mentalLegos.getAgentReadiness(),
      window.mentalLegos.getSpeechReadiness(),
      window.mentalLegos.getPrivacyOverview(),
    ]).then(([providerSetup, agentReadiness, speechReadiness, privacyOverview]) => {
      setSetup(providerSetup);
      setReadiness(agentReadiness);
      setSpeech(speechReadiness);
      setPrivacy(privacyOverview);
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
  const directProviders = useMemo(
    () => setup?.providers.filter((provider) => provider.protocol === 'anthropic-messages') ?? [],
    [setup],
  );
  const adaptedProviders = useMemo(
    () => setup?.providers.filter((provider) => provider.protocol === 'openai-chat-completions') ?? [],
    [setup],
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

  async function installSpeech(): Promise<void> {
    setSpeechBusy(true);
    setNotice('正在下载并逐文件校验本地语音模型，请勿关闭应用…');
    setError(null);
    try {
      setSpeech(await window.mentalLegos.installSpeechModel());
      setNotice('本地语音模型已就绪，训练时可直接开口说话。');
    } catch (reason) {
      setError(messageFrom(reason));
      setNotice(null);
    } finally {
      setSpeechBusy(false);
    }
  }

  async function exportData(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await window.mentalLegos.exportEncryptedData(exportPassword);
      setNotice(result.saved
        ? `已导出加密数据包：${result.fileName}`
        : '导出已取消。');
      setExportPassword('');
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-view">
      <section className="runtime-card" aria-labelledby="runtime-heading">
        <div>
          <p className="step-label">本地能力</p>
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

      <section className="runtime-card" aria-labelledby="speech-heading">
        <div>
          <p className="step-label">本地语音</p>
          <h2 id="speech-heading">SenseVoice 本地语音识别</h2>
          <p>
            语音默认在本机转写，音频不上传。模型
            {speech ? `（${speech.displayName}）` : ''}逐文件哈希校验后启用。
          </p>
        </div>
        <div className="runtime-actions">
          <span className={`badge ${speech?.model === 'ready' ? 'badge-ready' : ''}`}>
            语音模型 {speech?.model === 'ready' ? '就绪' : speech?.model === 'invalid' ? '异常' : '未安装'}
          </span>
          {speech && speech.model !== 'ready' && (
            <button
              className="secondary-button"
              type="button"
              disabled={speechBusy}
              onClick={() => void installSpeech()}
            >
              {speechBusy
                ? '正在下载…'
                : `下载并校验（约 ${Math.ceil(speech.downloadBytes / 1024 / 1024)} MB）`}
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
          核心始终是同一个 Claude Agent SDK Agent。所有预置服务均使用官方 Anthropic
          兼容端点由安全 Broker 直连；OpenAI Chat Completions 本地转换通道保留为
          没有官方 Anthropic 端点的服务的备用方案。密钥只进入受信任主进程，
          不进入界面、Agent 工作区、日志或 Git。
        </p>

        <div className="provider-lanes" aria-label="按量计费 API Key 说明">
          <article>
            <div className="lane-heading">
              <strong>Kimi 开放平台</strong>
              <span>官方 Anthropic 端点 · 直连</span>
            </div>
            <p>使用开放平台 API Key 和平台余额，按 API 用量计费。</p>
            <code>https://platform.kimi.com/console/api-keys</code>
          </article>
          <article>
            <div className="lane-heading">
              <strong>不支持订阅制 Coding Key</strong>
              <span>条款限制</span>
            </div>
            <p>
              Kimi Code 等面向编码工具的订阅套餐 Key 仅限官方允许的交互式编码用途，
              本产品不提供接入，避免违反其使用规范。
            </p>
          </article>
        </div>

        {setup?.configured && (
          <aside className="configured-card" aria-label="当前模型配置">
            <div>
              <strong>{setup.configured.displayName}</strong>
              <span>{setup.configured.model} · {protocolLabel(setup.configured.protocol)}</span>
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
            <span>服务接入方式</span>
            <select
              value={providerId}
              onChange={(event) => selectProvider(event.target.value as ProviderSetupInput['providerId'])}
            >
              <optgroup label="Anthropic Messages 直连">
                {directProviders.map((provider) => (
                  <option key={provider.id} value={provider.id}>{provider.displayName}</option>
                ))}
              </optgroup>
              {adaptedProviders.length > 0 && (
                <optgroup label="OpenAI Chat Completions（本地转换）">
                  {adaptedProviders.map((provider) => (
                    <option key={provider.id} value={provider.id}>{provider.displayName}</option>
                  ))}
                </optgroup>
              )}
              <option value="custom">自定义 Anthropic 兼容服务</option>
            </select>
          </label>

          <aside className="connection-detail wide-field" aria-live="polite">
            <div>
              <span>当前协议</span>
              <strong>{protocolLabel(selectedPreset?.protocol ?? 'anthropic-messages')}</strong>
            </div>
            <div>
              <span>正确的 Key 来源</span>
              <strong>{selectedPreset?.keySourceLabel ?? '自定义 Anthropic 兼容服务的 API Key'}</strong>
              {selectedPreset && <code>{selectedPreset.keySourceUrl}</code>}
            </div>
            <p>
              {selectedPreset?.billingNotice
                ?? '自定义服务仅按 Anthropic Messages 协议直连，并会标记为未认证。'}
            </p>
          </aside>

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
            <span>{selectedPreset?.keySourceLabel ?? 'API Key'}</span>
            <input
              type="password"
              value={apiKey}
              autoComplete="new-password"
              maxLength={2560}
              required
              spellCheck={false}
              onChange={(event) => setApiKey(event.target.value)}
            />
            <small>
              {selectedPreset
                ? `只接受来自 ${selectedPreset.keySourceUrl} 的对应产品密钥。`
                : '请填写该自定义 Anthropic 兼容服务的密钥。'}{' '}
              不要把真实密钥发到聊天、终端或提交到仓库。
            </small>
          </label>

          <div className="form-actions wide-field">
            <button className="primary-button" type="submit" disabled={busy || !setup}>
              {busy ? '正在安全保存…' : setup?.configured ? '替换配置' : '安全保存配置'}
            </button>
            <span className="source-note">
              {selectedPreset
                ? `${protocolLabel(selectedPreset.protocol)}；端点来自官方文档，完整能力仍需实测。`
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

      <section className="workspace" aria-labelledby="privacy-heading">
        <div className="section-heading">
          <div>
            <p className="step-label">数据与隐私</p>
            <h2 id="privacy-heading">你的数据留在本机</h2>
          </div>
        </div>
        {privacy && (
          <p className="section-copy">
            数据目录：<code>{privacy.dataDirectory}</code> · 占用约{' '}
            {(privacy.diskUsageBytes / 1024 / 1024).toFixed(1)} MB · 模块{' '}
            {privacy.counts.lego_modules ?? 0} · 场景 {privacy.counts.scenarios ?? 0} · 回答{' '}
            {privacy.counts.attempts ?? 0} · 确认记录 {privacy.counts.consent_events ?? 0}
          </p>
        )}
        <div className="provider-form">
          <label className="wide-field">
            <span>导出加密数据包（口令至少 8 位，丢失无法恢复）</span>
            <input
              type="password"
              value={exportPassword}
              minLength={8}
              maxLength={200}
              onChange={(event) => setExportPassword(event.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={busy || exportPassword.length < 8}
            onClick={() => void exportData()}
          >
            导出全部数据
          </button>
        </div>
      </section>
    </div>
  );
}
