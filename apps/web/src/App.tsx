import { useEffect, useState } from 'react';
import { isHealthResponse, type HealthResponse } from '@auto-mb/contracts';

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/health', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`API returned ${response.status}`);
        const payload: unknown = await response.json();
        if (!isHealthResponse(payload)) {
          throw new Error('API returned an unexpected payload');
        }
        return payload;
      })
      .then((payload) => {
        setHealth(payload);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return;
        setHealth(null);
        setError(reason instanceof Error ? reason.message : 'Unknown API error');
      });

    return () => controller.abort();
  }, []);

  return (
    <main className="shell">
      <section className="hero" aria-labelledby="page-title">
        <p className="eyebrow">POST-AWARD WORKS EXECUTION</p>
        <h1 id="page-title">Auto-MB</h1>
        <p className="lede">
          LOA to Delivery Challan, quantity ledger, and audit-ready document history.
        </p>
        <div className="status" role="status" aria-live="polite">
          <span className={health ? 'dot dot--ok' : error ? 'dot dot--error' : 'dot'} />
          {health
            ? `API online · ${health.version}`
            : error
              ? `API unavailable · ${error}`
              : 'Checking API…'}
        </div>
      </section>

      <section className="workflow" aria-labelledby="workflow-title">
        <h2 id="workflow-title">First release path</h2>
        <ol>
          <li>Upload and review an LOA</li>
          <li>Confirm the Work and awarded items</li>
          <li>Draft and issue a Delivery Challan</li>
          <li>Track issued and remaining quantities</li>
        </ol>
      </section>
    </main>
  );
}
