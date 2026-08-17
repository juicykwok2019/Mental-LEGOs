import { useEffect, useState } from 'react';

// An agent call is one opaque provider round-trip, so honest feedback is an
// indeterminate bar plus elapsed time and the normal duration range — never a
// fake percentage.
export function expectationFor(label: string): string {
  if (label.includes('分析') || label.includes('复盘') || label.includes('生成')
    || label.includes('诊断') || label.includes('提炼') || label.includes('判定')
    || label.includes('出题') || label.includes('追问') || label.includes('骨架')
    || label.includes('组装') || label.includes('重构')) {
    return '正在调用 AI，一般需要 30 秒 ~ 2 分钟，取决于服务商当时的速度';
  }
  if (label.includes('解析文件')) {
    return '本地解析，大文件可能需要十几秒';
  }
  return '本地操作，通常几秒内完成';
}

export function BusyIndicator(props: { label: string }) {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    setSeconds(0);
    const timer = window.setInterval(() => setSeconds((current) => current + 1), 1000);
    return () => window.clearInterval(timer);
  }, [props.label]);

  return (
    <div className="busy-indicator" role="status" aria-live="polite">
      <div className="busy-bar" aria-hidden="true"><div className="busy-bar-fill" /></div>
      <p>
        {props.label}
        {seconds > 0 && ` 已等待 ${seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`}`}
        {' · '}{expectationFor(props.label)}
      </p>
    </div>
  );
}
