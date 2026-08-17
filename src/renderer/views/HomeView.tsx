import { useEffect, useState } from 'react';

import type { ProfileState, TrainingDueItem } from '../../shared/contracts';
import { stageLabel } from '../labels';

export interface HomeViewProps {
  profile: ProfileState;
  busy: boolean;
  onStartOpenPractice(topic: string): void;
  onCreateScenario(): void;
  onEditProfile(): void;
  onOpenAbout(): void;
}

export function HomeView(props: HomeViewProps) {
  const [topic, setTopic] = useState('');
  const [due, setDue] = useState<TrainingDueItem[]>([]);

  useEffect(() => {
    window.mentalLegos.getDueModules().then(setDue).catch(() => setDue([]));
  }, []);

  return (
    <div className="home-view">
      <section className="home-hero">
        <p className="home-line">
          {props.profile.seed
            ? `方向：${props.profile.seed.direction}`
            : '还没有专业画像'}
          <button type="button" className="quiet-button" onClick={props.onEditProfile}>
            调整画像
          </button>
        </p>
        <p className="home-stats">
          已确认模块 {props.profile.moduleCount} · 画像观察 {props.profile.confirmedAssertions.length}
          {props.profile.knowledgeGapCount > 0 && ` · 知识缺口 ${props.profile.knowledgeGapCount}`}
        </p>
      </section>

      <section className="home-entries">
        <article className="entry-card">
          <h2>开始一次开放训练</h2>
          <p>系统基于你的画像、材料和已有模块出一道题。先答，后辅助，最后换问法再调用一次。</p>
          <input
            placeholder="可选：本次想练的主题"
            value={topic}
            maxLength={200}
            onChange={(event) => setTopic(event.target.value)}
          />
          <button
            type="button"
            className="primary-button"
            disabled={props.busy}
            onClick={() => props.onStartOpenPractice(topic.trim())}
          >
            开始训练
          </button>
        </article>
        <article className="entry-card">
          <h2>创建一个专项场景</h2>
          <p>面试、汇报、谈判或演讲：导入材料，系统识别对方会问什么，事前模拟、事后复盘。</p>
          <button type="button" className="secondary-button" disabled={props.busy} onClick={props.onCreateScenario}>
            创建场景
          </button>
        </article>
      </section>

      {due.length > 0 && (
        <section className="due-strip">
          <strong>到期复现<span className="count-pill">{due.length}</span></strong>
          {due.slice(0, 5).map((item) => (
            <span key={item.moduleId} className="due-chip">
              {item.title} · {stageLabel(item.stage)}
            </span>
          ))}
          <p className="due-hint">开始一次开放训练即可覆盖到期模块的复现。</p>
        </section>
      )}

      <p className="about-link">
        <button type="button" className="quiet-button" onClick={props.onOpenAbout}>
          心智乐高是什么？了解产品理念 →
        </button>
      </p>
    </div>
  );
}
