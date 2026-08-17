export interface AboutViewProps {
  onBack(): void;
}

export function AboutView(props: AboutViewProps) {
  return (
    <div className="library-view">
      <header className="chat-header">
        <button type="button" className="quiet-button" onClick={props.onBack}>← 返回首页</button>
        <span>产品理念</span>
        <span />
      </header>
      <section className="workspace" aria-labelledby="philosophy-heading">
        <div className="section-heading">
          <div>
            <p className="step-label">产品理念</p>
            <h2 id="philosophy-heading">Mental LEGOs 是什么</h2>
          </div>
        </div>
        <p className="section-copy">
          心智乐高——把人类的认知、思维模型、技能与知识库拆解为像乐高积木一样的"标准模块"，
          再根据不同的场景和需求，自由拼装、重构出应对复杂问题的心智架构。
          这个应用是该理念在专业口语表达上的落地：每一次训练，都是在为你自己的零件库添砖。
        </p>
        <div className="provider-lanes philosophy-lanes">
          <article>
            <div className="lane-heading">
              <strong>思维模型与知识的模块化</strong>
            </div>
            <p>
              可组合性：像乐高有标准的尺寸与形状，复杂的理论、商业框架、算法逻辑或生活经验，
              可以提炼成一个个独立、内聚、可复用的"思维模块"。
            </p>
            <p>
              动态组装：遇到新问题不再从零开始思考，而是从脑海中的零件库里挑出历史经验、
              第一性原理、数据分析或系统思维模块，快速拼出解决方案。
            </p>
          </article>
          <article>
            <div className="lane-heading">
              <strong>AI 时代的设计哲学</strong>
            </div>
            <p>
              Agent 架构与工具调用：大模型、RAG、向量数据库、Prompt 模板、MCP 与各种 API 工具，
              本质上就是数字世界的 Mental LEGOs——按业务需要拼接成定制化的智能工作流。
            </p>
            <p>
              分层与解耦：高手的思维是组件化的——把复杂系统拆成低耦合、高内聚的小模块，
              随时拔插、替换或升级。这个应用自身也按此哲学构建。
            </p>
          </article>
          <article>
            <div className="lane-heading">
              <strong>个人知识管理与终身学习</strong>
            </div>
            <p>
              原子化知识：在知识管理中，如卡片盒笔记法（Zettelkasten）强调"原子化笔记"——
              每一条笔记只讲一个独立的概念，这正是知识层面的"乐高积木"。
              随着积累的增多，这些原子化的知识可以随时随地被调用，
              组合成一篇文章、一个产品方案或一次深刻的洞察。
            </p>
            <p>
              认知迭代的敏捷性：当环境变化时，旧的思维方式如果过时了，
              不需要推翻整个认知体系，只需要"拆掉几块积木，换上新模块"，
              即可完成思维的迭代。
            </p>
          </article>
        </div>
        <p className="section-copy">
          乐高库里的每个语言模块 = 语义内核 + 逻辑骨架 + 语言外壳，
          全部提炼自你自己的表达、并经你亲手确认——它们是属于你的、可反复调用的表达资产。
        </p>
      </section>
    </div>
  );
}
