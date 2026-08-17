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
          <span />
        </header>
        {error && <p className="form-error">{error}</p>}
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
              <p>场景模块默认不进入长期库；确认它可跨场景复用后再提升。</p>
              <div className="phase-actions">
                <button
                  type="button"
                  disabled={working}
                  onClick={() => void step(async () => {
                    await window.mentalLegos.promoteLibraryModule({
                      moduleId: detail.id, domain: 'generic',
                    });
                    setDetail(await window.mentalLegos.getLibraryModule(detail.id));
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
                  })}
                >
                  提升为专业模块
                </button>
              </div>
            </section>
          )}

          <button
            type="button"
            className="quiet-button"
            disabled={working}
            onClick={() => void step(async () => {
              await window.mentalLegos.archiveLibraryModule(detail.id);
              setDetail(null);
            })}
          >
            归档此模块
          </button>
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
