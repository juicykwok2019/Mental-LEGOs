import { useEffect, useState } from 'react';

import type { LibraryModuleDetail, LibraryModuleSummary } from '../../shared/contracts';

function messageFrom(reason: unknown): string {
  return reason instanceof Error ? reason.message : '发生了未知错误。';
}

function scopeLabel(module: LibraryModuleSummary): string {
  if (module.scope === 'scenario') return '场景';
  return module.domain === 'generic' ? '通用' : '专业';
}

export function LibraryView() {
  const [modules, setModules] = useState<LibraryModuleSummary[]>([]);
  const [detail, setDetail] = useState<LibraryModuleDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [note, setNote] = useState('');
  const [versionToDelete, setVersionToDelete] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [archiveConfirm, setArchiveConfirm] = useState(false);

  async function refresh(): Promise<void> {
    try {
      setModules(await window.mentalLegos.listLibraryModules());
    } catch (reason) {
      setError(messageFrom(reason));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function step(work: () => Promise<unknown>): Promise<void> {
    setWorking(true);
    setError(null);
    try {
      await work();
      await refresh();
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setWorking(false);
    }
  }

  if (detail) {
    return (
      <div className="library-view">
        <header className="chat-header">
          <button type="button" className="quiet-button" onClick={() => setDetail(null)}>← 模块库</button>
          <span>{detail.title}</span>
          <button type="button" className="quiet-button" onClick={() => setShowHelp((current) => !current)}>
            {showHelp ? '收起说明' : '❓ 这些词是什么意思'}
          </button>
        </header>
        {error && <p className="form-error">{error}</p>}
        {notice && <p className="material-notice">{notice}</p>}
        {showHelp && (
          <div className="module-detail">
            <p className="block-hint">
              一个语言乐高模块由四部分组成——
              <strong>语义内核</strong>：这块积木要表达的核心判断，一句话说清"你想说什么"；
              <strong>逻辑骨架</strong>：把内核展开成几步推理的顺序，回答时照这个骨架走；
              <strong>语言外壳</strong>：你自己的原话措辞（提炼时优先保留你回答里的用词，开口时直接可说）；
              <strong>触发线索</strong>：听到什么样的问题，应该想起并调用这个模块。
            </p>
            <p className="block-hint">
              <strong>掌握阶段</strong>会随训练与现实使用升降，决定<strong>下次复现</strong>的时间——
              到期的模块会出现在首页提示条里，提醒你换个问法再练一次。
            </p>
          </div>
        )}
        <div className="module-detail">
          <p><strong>作用域</strong> {scopeLabel(detail)} · {detail.category}
            {detail.stage && ` · 掌握阶段 ${detail.stage}`}
            {detail.dueAt && ` · 下次复现 ${detail.dueAt.slice(0, 10)}`}
          </p>
          <p><strong>语义内核</strong> {detail.semanticKernel}</p>
          <p><strong>逻辑骨架</strong> {detail.logicSkeleton.join(' → ')}</p>
          <p><strong>语言外壳</strong></p>
          <ul>{detail.languageShells.map((shell, index) => <li key={index}>{shell}</li>)}</ul>
          {detail.triggers.length > 0 && (
            <p><strong>触发线索</strong> {detail.triggers.join(' / ')}</p>
          )}

          <section className="scenario-block">
            <h3>现实使用了这个模块？</h3>
            <p className="block-hint">
              在真实会议、面试或沟通里用过它之后，回来点一下：成功=当场如期调用出来；
              部分=想起来了但没说完整；没调用出来=当场没想起。
              上报会直接影响这个模块的掌握阶段和下次复现时间。
            </p>
            <input
              placeholder="一句话备注（可选）"
              value={note}
              maxLength={4000}
              onChange={(event) => setNote(event.target.value)}
            />
            <div className="phase-actions">
              {(['success', 'partial', 'failure'] as const).map((result) => (
                <button
                  key={result}
                  type="button"
                  className="secondary-button"
                  disabled={working}
                  onClick={() => void step(async () => {
                    await window.mentalLegos.reportRealWorldUse({
                      moduleId: detail.id, result, note: note.trim(),
                    });
                    setNote('');
                    setDetail(await window.mentalLegos.getLibraryModule(detail.id));
                  })}
                >
                  {result === 'success' ? '成功调用' : result === 'partial' ? '部分调用' : '没调用出来'}
                </button>
              ))}
            </div>
          </section>

          {detail.versions.length > 0 && (
            <section className="scenario-block">
              <h3>版本历史（{detail.versions.length}）</h3>
              <ul className="version-list">
                {detail.versions.map((entry) => (
                  <li key={entry.version}>
                    <span>
                      v{entry.version}
                      {entry.isCurrent && '（当前）'}
                      {' · '}{entry.createdAt.slice(0, 10)}
                      {' · '}{entry.authorship === 'user' ? '本人表达' : entry.authorship}
                    </span>
                    {versionToDelete === entry.version ? (
                      <span className="phase-actions">
                        <button
                          type="button"
                          className="quiet-button"
                          disabled={working}
                          onClick={() => void step(async () => {
                            setDetail(await window.mentalLegos.deleteModuleVersion({
                              moduleId: detail.id, version: entry.version,
                            }));
                            setVersionToDelete(null);
                          })}
                        >
                          确认删除
                        </button>
                        <button
                          type="button"
                          className="quiet-button"
                          onClick={() => setVersionToDelete(null)}
                        >
                          取消
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="quiet-button"
                        disabled={working || detail.versions.length <= 1}
                        title={detail.versions.length <= 1 ? '模块只剩这一个版本；要移除全部内容请归档模块' : ''}
                        onClick={() => setVersionToDelete(entry.version)}
                      >
                        删除此版本
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {detail.scope === 'scenario' && (
            <section className="scenario-block">
              <h3>提升为长期模块</h3>
              <p className="block-hint">
                场景模块默认只属于它的场景，场景删除时会一并删除；
                确认这块积木可以跨场景复用后，提升为长期模块——
                通用=任何行业沟通都能用，专业=绑定你的专业领域。
              </p>
              <div className="phase-actions">
                <button
                  type="button"
                  disabled={working}
                  onClick={() => void step(async () => {
                    await window.mentalLegos.promoteLibraryModule({
                      moduleId: detail.id, domain: 'generic',
                    });
                    setDetail(await window.mentalLegos.getLibraryModule(detail.id));
                    setNotice('✓ 已提升为通用模块——它已从"场景模块"移入库首页的"通用模块"分组，进入长期复现调度，之后删除原场景也不会影响它。');
                  })}
                >
                  提升为通用模块
                </button>
                <button
                  type="button"
                  disabled={working}
                  onClick={() => void step(async () => {
                    await window.mentalLegos.promoteLibraryModule({
                      moduleId: detail.id, domain: 'professional',
                    });
                    setDetail(await window.mentalLegos.getLibraryModule(detail.id));
                    setNotice('✓ 已提升为专业模块——它已从"场景模块"移入库首页的"专业模块"分组，进入长期复现调度，之后删除原场景也不会影响它。');
                  })}
                >
                  提升为专业模块
                </button>
              </div>
            </section>
          )}

          <section className="scenario-block">
            <h3>归档此模块</h3>
            <p className="block-hint">
              归档=把模块从库和复现安排中移出：不再出现在列表里，也不再提醒复现，
              但数据保留（不同于删除）。适合已经过时、或不想再练的表达。
            </p>
            {archiveConfirm ? (
              <div className="phase-actions">
                <button
                  type="button"
                  className="quiet-button"
                  disabled={working}
                  onClick={() => void step(async () => {
                    await window.mentalLegos.archiveLibraryModule(detail.id);
                    setDetail(null);
                    setArchiveConfirm(false);
                  })}
                >
                  确认归档
                </button>
                <button type="button" className="quiet-button" onClick={() => setArchiveConfirm(false)}>
                  取消
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="quiet-button"
                disabled={working}
                onClick={() => setArchiveConfirm(true)}
              >
                归档此模块…
              </button>
            )}
          </section>
        </div>
      </div>
    );
  }

  const groups: Array<{ label: string; filter: (module: LibraryModuleSummary) => boolean }> = [
    { label: '通用模块', filter: (module) => module.scope === 'global' && module.domain === 'generic' },
    { label: '专业模块', filter: (module) => module.scope === 'global' && module.domain !== 'generic' },
    { label: '场景模块', filter: (module) => module.scope === 'scenario' },
  ];

  return (
    <div className="library-view">
      <h2>语言乐高库</h2>
      {error && <p className="form-error">{error}</p>}
      {modules.length === 0 && <p>还没有模块。完成一次训练并确认候选后，它们会出现在这里。</p>}
      {groups.map((group) => {
        const items = modules.filter(group.filter);
        if (items.length === 0) return null;
        return (
          <section key={group.label} className="library-group">
            <h3>{group.label}（{items.length}）</h3>
            <div className="scenario-list">
              {items.map((module) => (
                <button
                  key={module.id}
                  type="button"
                  className="scenario-item"
                  onClick={() => {
                    setVersionToDelete(null);
                    setNotice(null);
                    setArchiveConfirm(false);
                    window.mentalLegos.getLibraryModule(module.id)
                      .then(setDetail)
                      .catch((reason: unknown) => setError(messageFrom(reason)));
                  }}
                >
                  <strong>{module.title}</strong>
                  <span>
                    {module.category}
                    {module.stage && ` · ${module.stage}`}
                    {module.dueAt && ` · 复现 ${module.dueAt.slice(0, 10)}`}
                  </span>
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
