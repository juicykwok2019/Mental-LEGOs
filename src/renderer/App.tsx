import { useEffect, useState } from 'react';

import type { AppInfo } from '../shared/contracts';

export function App() {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.mentalLegos.getAppInfo()
      .then(async (info) => {
        setAppInfo(info);
        await window.mentalLegos.reportReady();
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : 'Unknown error');
      });
  }, []);

  return (
    <main className="app-shell">
      <section className="hero" aria-labelledby="product-title">
        <p className="eyebrow">Phase 0 · Architecture verification</p>
        <h1 id="product-title">Mental LEGOs</h1>
        <p className="summary">
          Build reusable language modules. Practice recalling and recombining
          them when professional conversations become unpredictable.
        </p>
        <div className="status-card" aria-live="polite">
          <span className="status-dot" aria-hidden="true" />
          {error
            ? `Desktop bridge unavailable: ${error}`
            : appInfo
              ? `${appInfo.name} ${appInfo.version} · secure desktop shell ready`
              : 'Verifying the secure desktop bridge…'}
        </div>
      </section>
    </main>
  );
}
