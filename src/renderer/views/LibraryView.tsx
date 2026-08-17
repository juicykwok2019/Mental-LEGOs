import { useEffect, useState } from 'react';

import type { LibraryModuleDetail, LibraryModuleSummary } from '../../shared/contracts';
import { categoryLabel, stageLabel } from '../labels';

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
          <button type="button" className="quiet-button" onClick={() => setDetail(null)}>← 积木库</button>
          <span>{detail.title}</span>
          <span />
        </header>
        {error && <p className="form-error">{error}</p>}
        {notice && <p className="material-notice">{notice}</p>}
        <div className="module-detail">
          <div className="module-meta">
            <span className="badge badge-ready">{scopeLabel(detail)}模块</span>
            <span className="badge">{categoryLabel(detail.category)}</span>
            {detail.stage && <span className="badge">掌握阶段 · {stageLabel(detail.stage)}</span>}
            {detail.dueAt && <span className="badge">下次复现 · {detail.dueAt.slice(0, 10)}</span>}
          </div>
          {detail.dueAt && (
            <p className="block-hint">到期的模块会出现在首页提示条，提醒你换个问法再练一次。</p>
          )}

          <div className="anatomy-header">
            <h3 className="anatomy-heading">模块解剖</h3>
            <p className="block-hint">
              语义内核 / 逻辑骨架 / 语言外壳 / 触发线索——四件套合起来，才是一块随时可调用的表达积木。
            </p>
          </div>

          <div className="anatomy">
            <div className="anatomy-item">
              <div className="anatomy-label">语义内核<span>你想表达的核心判断，一句话</span></div>
              <p className="anatomy-kernel">{detail.semanticKernel}</p>
            </div>
            <div className="anatomy-item">
              <div className="anatomy-label">逻辑骨架<span>展开时照着走的推理步骤</span></div>
              <ol className="anatomy-steps">
                {detail.logicSkeleton.map((step, index) => <li key={index}>{step}</li>)}
              </ol>
            </div>
            <div className="anatomy-item">
              <div className="anatomy-label">语言外壳<span>你自己的原话，开口直接可说</span></div>
              <ul className="anatomy-shells">
                {detail.languageShells.map((shell, index) => <li key={index}>{shell}</li>)}
              </ul>
            </div>
            {detail.triggers.length > 0 && (
              <div className="anatomy-item">
                <div className="anatomy-label">触发线索<span>听到这类问题时，调用这块积木</span></div>
                <div className="trigger-chips">
                  {detail.triggers.map((trigger, index) => (
                    <span key={index} className="due-chip">{trigger}</span>
                  ))}
                </div>
              </div>
            )}
          </div>

          <section className="scenario-block">
            <h3>反馈一下掌握情况？</h3>
            <p className="block-hint">
              在真实会议、面试或沟通里用过它之后，回来点一下：成功=当场如期调用出来；
              部分=想起来了但没说完整；没调用出来=当场没想起。
              上报会直接影响这个模块的掌握阶段和下次复现时间。
            </p>
            <input
              placeholder="一句话备注（可选，点下方按钮时随反馈一起保存）"
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
                    const savedNote = note.trim();
                    await window.mentalLegos.reportRealWorldUse({
                      moduleId: detail.id, result, note: savedNote,
                    });
                    setNote('');
                    const refreshed = await window.mentalLegos.getLibraryModule(detail.id);
                    setDetail(refreshed);
                    const label = result === 'success' ? '成功调用' : result === 'partial' ? '部分调用' : '没调用出来';
                    setNotice(`✓ 已记录「${label}」${savedNote ? '（备注已保存）' : ''}——掌握阶段现在是「${refreshed.stage ? stageLabel(refreshed.stage) : '未评估'}」${refreshed.dueAt ? `，下次复现 ${refreshed.dueAt.slice(0, 10)}` : ''}。`);
                  })}
                >
                  {result === 'success' ? '成功调用' : result === 'partial' ? '部分调用' : '没调用出来'}
                </button>
              ))}
            </div>
          </section>

          {detail.versions.length > 0 && (
            <section className="scenario-block">
              <h3>版本历史<span className="count-pill">{detail.versions.length}</span></h3>
              <p className="block-hint">
                同一块积木的措辞演进史：以后再训练或复盘同一主题、提炼出更好的说法时，
                会存为新版本而不覆盖旧的——训练时调用的始终是"当前版"。
                某一版措辞含敏感信息时可单独删除；删当前版会自动回退到上一版。
              </p>
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
                    ) : detail.versions.length <= 1 ? (
                      <span className="version-locked">唯一版本不可删；整块移除请用下方"归档"</span>
                    ) : (
                      <button
                        type="button"
                        className="quiet-button"
                        disabled={working}
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

          {detail.scope === 'global' && detail.status !== 'archived' && (
            <p className="block-hint">
              这已经是长期模块（{detail.domain === 'generic' ? '通用' : '专业'}），
              不依附任何场景，无需提升。
            </p>
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

          {detail.status === 'archived' ? (
            <section className="scenario-block">
              <h3>已归档</h3>
              <p className="block-hint">
                这个模块处于归档状态：不参与复现调度，只出现在库首页的"已归档"分组里。
                恢复后回到原分组，重新进入复现调度。
              </p>
              <button
                type="button"
                disabled={working}
                onClick={() => void step(async () => {
                  setDetail(await window.mentalLegos.restoreLibraryModule(detail.id));
                  setNotice('✓ 已恢复——模块回到了库中的原分组，并重新进入复现调度。');
                })}
              >
                恢复此模块
              </button>
            </section>
          ) : (
          <section className="scenario-block">
            <h3>归档此模块</h3>
            <p className="block-hint">
              适合已经过时、或不想再练的表达。归档后移入库首页的"已归档"分组，不再提醒复现；
              数据保留，随时可从"已归档"里恢复。
              如要彻底删除：单个版本在上方"版本历史"中删除；场景模块会随"删除场景"一并彻底删除。
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
          )}
        </div>
      </div>
    );
  }

  const active = (module: LibraryModuleSummary): boolean => module.status !== 'archived';
  const groups: Array<{ label: string; filter: (module: LibraryModuleSummary) => boolean }> = [
    { label: '通用模块', filter: (module) => active(module) && module.scope === 'global' && module.domain === 'generic' },
    { label: '专业模块', filter: (module) => active(module) && module.scope === 'global' && module.domain !== 'generic' },
    { label: '场景模块', filter: (module) => active(module) && module.scope === 'scenario' },
    { label: '已归档', filter: (module) => module.status === 'archived' },
  ];

  return (
    <div className="library-view">
      <h2 className="view-title">积木库</h2>
      {error && <p className="form-error">{error}</p>}
      {modules.length === 0 && <p>还没有模块。完成一次训练并确认候选后，它们会出现在这里。</p>}
      {groups.map((group) => {
        const items = modules.filter(group.filter);
        if (items.length === 0) return null;
        return (
          <section key={group.label} className="library-group">
            <h3>{group.label}<span className="count-pill">{items.length}</span></h3>
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
                    {categoryLabel(module.category)}
                    {module.stage && ` · ${stageLabel(module.stage)}`}
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
