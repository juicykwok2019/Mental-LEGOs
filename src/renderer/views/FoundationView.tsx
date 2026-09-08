import { useEffect, useState } from 'react';

import type { FoundationOverview } from '../../shared/contracts';
import { knowledgeKindLabel, tierLabel } from '../labels';

function messageFrom(reason: unknown): string {
  return reason instanceof Error ? reason.message : '发生了未知错误。';
}

export interface FoundationViewProps {
  onEditProfile(): void;
}

export function FoundationView(props: FoundationViewProps) {
  const [overview, setOverview] = useState<FoundationOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [knowledgeToDelete, setKnowledgeToDelete] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    window.mentalLegos.getFoundationOverview()
      .then(setOverview)
      .catch((reason: unknown) => setError(messageFrom(reason)));
  }, []);

  async function step(work: () => Promise<FoundationOverview>): Promise<void> {
    setWorking(true);
    setError(null);
    try {
      setOverview(await work());
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setWorking(false);
    }
  }

  if (!overview) {
    return (
      <div className="library-view">
        {error ? <p className="form-error">{error}</p> : <p className="block-hint">加载中…</p>}
      </div>
    );
  }

  const candidates = overview.assertions.filter((assertion) => assertion.status === 'candidate');
  const confirmed = overview.assertions.filter((assertion) => assertion.status === 'confirmed');

  return (
    <div className="library-view">
      {error && <p className="form-error">{error}</p>}
      <p className="block-hint">
        个人底座是系统对你的全部了解——出题、追问和场景分析都以这里为根据。
        每一条都来自你的训练与确认，可以在这里复核、修正或删除。
      </p>

      <section className="scenario-block">
        <h3>画像种子</h3>
        <p className="block-hint">你最初填的三句话起点；训练中的观察会在下面持续长出来。</p>
        {overview.seed ? (
          <>
            <p>方向：{overview.seed.direction}</p>
            {overview.seed.currentWork && <p>最近在做：{overview.seed.currentWork}</p>}
            {overview.seed.targetScenarios && <p>想练的场景：{overview.seed.targetScenarios}</p>}
            {overview.seed.material && (
              <p className="block-hint">附带材料 {overview.seed.material.length.toLocaleString()} 字符（加密存储）</p>
            )}
          </>
        ) : (
          <p className="block-hint">还没有画像种子。</p>
        )}
        <button type="button" className="secondary-button" onClick={props.onEditProfile}>
          调整画像种子
        </button>
      </section>

      <section className="scenario-block">
        <h3>
          画像观察
          {overview.assertions.length > 0 && <span className="count-pill">{overview.assertions.length}</span>}
        </h3>
        <p className="block-hint">
          训练中系统对你形成的判断，按证据逐级晋升：观察线索先在后台积累，
          满 2 轮独立证据才会出现在这里请你复核（待验假设）；满 4 轮自动晋升"有据观察"；
          "已确认事实"只能由你亲手点。只有确认过的才会当作事实用于出题；不准的直接点"不是我"。
          观察不是永久的：已确认的事实 90 天没有新证据会自动回到这里待你复核；
          任何一条都可以随时点"不再是我"移除——表达习惯会变，画像跟着现在的你走。
        </p>
        {candidates.length === 0 && confirmed.length === 0 && (
          <p className="block-hint">还没有观察。完成几轮训练后，系统的观察会出现在这里等你复核。</p>
        )}
        {candidates.length > 0 && (
          <ul className="version-list">
            {candidates.map((assertion) => (
              <li key={assertion.id}>
                <span>
                  {assertion.statement}
                  <em className="material-intent">{tierLabel(assertion.tier)} · 证据 {assertion.evidenceCount} 轮 · 待你复核</em>
                </span>
                <span className="phase-actions">
                  <button
                    type="button"
                    className="quiet-button intent-edit-button"
                    disabled={working}
                    onClick={() => void step(() => window.mentalLegos.resolveFoundationAssertion({
                      assertionId: assertion.id, resolution: 'confirmed',
                    }))}
                  >
                    确认属实
                  </button>
                  <button
                    type="button"
                    className="quiet-button"
                    disabled={working}
                    onClick={() => void step(() => window.mentalLegos.resolveFoundationAssertion({
                      assertionId: assertion.id, resolution: 'rejected',
                    }))}
                  >
                    不是我
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
        {confirmed.length > 0 && (
          <ul className="version-list">
            {confirmed.map((assertion) => (
              <li key={assertion.id}>
                <span>
                  {assertion.statement}
                  <em className="material-intent">{tierLabel(assertion.tier)} · 证据 {assertion.evidenceCount} 轮 · {assertion.createdAt.slice(0, 10)}</em>
                </span>
                <button
                  type="button"
                  className="quiet-button"
                  disabled={working}
                  onClick={() => void step(() => window.mentalLegos.resolveFoundationAssertion({
                    assertionId: assertion.id, resolution: 'retired',
                  }))}
                >
                  不再是我
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="scenario-block">
        <h3>
          知识底座
          {overview.knowledge.length > 0 && <span className="count-pill">{overview.knowledge.length}</span>}
        </h3>
        <p className="block-hint">
          训练与复盘沉淀下来的事实、案例、观点与方法；"待思考"是你标记过的知识缺口——
          等你形成判断后，这些话题会重新出现在训练里。点条目可展开全文。
        </p>
        {overview.knowledge.length === 0 && (
          <p className="block-hint">还没有沉淀。训练中标记知识缺口、或复盘真实交流后，会在这里积累。</p>
        )}
        {overview.knowledge.length > 0 && (
          <ul className="version-list">
            {overview.knowledge.map((item) => (
              <li key={item.id} className="knowledge-row">
                <span
                  role="button"
                  tabIndex={0}
                  className="knowledge-main"
                  onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') setExpandedId(expandedId === item.id ? null : item.id);
                  }}
                >
                  <em className="scope-tag">{knowledgeKindLabel(item.kind)}</em>
                  {item.title}
                  {expandedId === item.id && (
                    <em className="material-intent knowledge-content">{item.content}</em>
                  )}
                </span>
                {knowledgeToDelete === item.id ? (
                  <span className="phase-actions">
                    <button
                      type="button"
                      className="quiet-button"
                      disabled={working}
                      onClick={() => void step(async () => {
                        const next = await window.mentalLegos.deleteFoundationKnowledge(item.id);
                        setKnowledgeToDelete(null);
                        return next;
                      })}
                    >
                      确认删除
                    </button>
                    <button type="button" className="quiet-button" onClick={() => setKnowledgeToDelete(null)}>
                      取消
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="quiet-button"
                    disabled={working}
                    onClick={() => setKnowledgeToDelete(item.id)}
                  >
                    删除
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {overview.knowledgeGapCount > 0 && (
          <p className="block-hint">
            累计标记过 {overview.knowledgeGapCount} 次知识缺口
            {overview.recentGaps.length > 0 && `，最近的话题：${overview.recentGaps.slice(0, 3).join('；')}`}。
          </p>
        )}
      </section>
    </div>
  );
}
