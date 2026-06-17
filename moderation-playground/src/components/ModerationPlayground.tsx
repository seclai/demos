import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';

// Mirror of the server-side ModerationResult shape (src/lib/moderation.ts),
// kept inline so the component is self-contained on the client.
type Decision = 'approve' | 'review' | 'reject';
type Severity = 'high' | 'medium' | 'low';
interface Violation { rule: string; severity: Severity; explanation: string; }
interface AdvisoryFlag { flag: string; explanation: string; }
interface ModerationResult {
  is_listing_photo: boolean;
  not_photo_reason: string | null;
  decision: Decision;
  violations: Violation[];
  advisory_flags: AdvisoryFlag[];
  quality_score: number;
  confidence: number;
}

type Status = 'empty' | 'loading' | 'done' | 'error' | 'not_photo';
type View = 'card' | 'json';

const ACCEPT = 'image/png,image/jpeg';

const VERDICT = {
  approve: { color: '#16A34A', glyph: '✓', label: 'Approve', sub: 'Listing meets marketplace policies.', bg: 'rgba(22,163,74,0.07)', border: 'rgba(22,163,74,0.25)' },
  review: { color: '#D97706', glyph: '!', label: 'Review', sub: 'Manual review recommended before publishing.', bg: 'rgba(217,119,6,0.07)', border: 'rgba(217,119,6,0.25)' },
  reject: { color: '#DC2626', glyph: '✕', label: 'Reject', sub: 'Listing violates marketplace policies.', bg: 'rgba(220,38,38,0.07)', border: 'rgba(220,38,38,0.25)' },
} as const;

const SEV = {
  high: { color: '#DC2626', bg: 'rgba(220,38,38,0.10)' },
  medium: { color: '#D97706', bg: 'rgba(217,119,6,0.10)' },
  low: { color: '#64748B', bg: 'rgba(100,116,139,0.10)' },
} as const;

const pct = (v: number) => Math.round(v * 100);
const qualityColor = (q: number) => (q >= 0.8 ? '#16A34A' : q >= 0.6 ? '#D97706' : '#DC2626');

// Lightweight JSON syntax highlighter for the JSON tab.
function JsonView({ data }: { data: unknown }) {
  const lines = JSON.stringify(data, null, 2).split('\n');
  const color = (rest: string): string => {
    if (/^".*"$/.test(rest)) return '#16A34A';
    if (/^-?\d/.test(rest)) return '#D97706';
    if (/^(true|false|null)$/.test(rest)) return '#DC2626';
    if (/^[[\]{}]+$/.test(rest)) return '#94A3B8';
    return '#0F172A';
  };
  return (
    <div className="json">
      {lines.map((line, i) => {
        const ws = line.match(/^\s*/)![0];
        let rest = line.slice(ws.length);
        const keyMatch = rest.match(/^("(?:[^"\\]|\\.)*")(\s*:\s*)/);
        let key: [string, string] | null = null;
        if (keyMatch) { key = [keyMatch[1], keyMatch[2]]; rest = rest.slice(keyMatch[0].length); }
        let trailing = '';
        if (rest.endsWith(',')) { trailing = ','; rest = rest.slice(0, -1); }
        return (
          <div key={i} className="json-line">
            {ws}
            {key && (<><span style={{ color: '#4F46E5' }}>{key[0]}</span><span style={{ color: '#94A3B8' }}>{key[1]}</span></>)}
            {rest && <span style={{ color: color(rest) }}>{rest}</span>}
            {trailing && <span style={{ color: '#94A3B8' }}>{trailing}</span>}
          </div>
        );
      })}
    </div>
  );
}

export default function ModerationPlayground() {
  const [status, setStatus] = useState<Status>('empty');
  const [view, setView] = useState<View>('card');
  const [dragOver, setDragOver] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [caption, setCaption] = useState('');
  const [result, setResult] = useState<ModerationResult | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const setImage = useCallback((f: File | null | undefined) => {
    if (!f) return;
    setPreviewUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(f); });
    setFile(f);
    setStatus('empty');
    setResult(null);
    setError(null);
  }, []);

  const clearImage = useCallback(() => {
    setPreviewUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
    setFile(null);
    setStatus('empty');
    setResult(null);
    setError(null);
  }, []);

  const onDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    setImage(e.dataTransfer.files?.[0]);
  }, [setImage]);

  const run = useCallback(async () => {
    if (!file || status === 'loading') return;
    setStatus('loading');
    setError(null);
    setResult(null);
    try {
      const body = new FormData();
      body.append('image', file);
      if (caption.trim()) body.append('caption', caption.trim());
      const res = await fetch('/api/moderate', { method: 'POST', body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data?.kind === 'not_listing_photo') {
          setError(data?.error || "That doesn't look like a listing photo.");
          setStatus('not_photo');
          return;
        }
        throw new Error(data?.error || `Request failed (${res.status}).`);
      }
      setResult(data.result as ModerationResult);
      setLatencyMs(typeof data.latencyMs === 'number' ? data.latencyMs : null);
      setView('card');
      setStatus('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setStatus('error');
    }
  }, [file, caption, status]);

  return (
    <div className="app">
      {/* TOP BAR */}
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><span className="brand-diamond" /></span>
          <span className="brand-title">Moderation Playground</span>
          <span className="brand-pill">powered by Seclai</span>
        </div>
      </header>

      {/* MAIN */}
      <main className="main">
        <div className="layout">
          {/* LEFT: INPUT */}
          <section className="panel input-panel">
            <div className="panel-label">Input</div>

            <input ref={inputRef} type="file" accept={ACCEPT} hidden
              onChange={(e) => { setImage(e.target.files?.[0]); e.target.value = ''; }} />

            {previewUrl ? (
              <div className="preview">
                <div className="preview-img" style={{ backgroundImage: `url(${previewUrl})` }} />
                <button className="preview-clear" onClick={clearImage} aria-label="Remove image">✕</button>
                {file && <div className="preview-name">{file.name}</div>}
              </div>
            ) : (
              <div
                className={`drop${dragOver ? ' over' : ''}`}
                role="button" tabIndex={0}
                onClick={() => inputRef.current?.click()}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click(); } }}
                onDragOver={(e) => { e.preventDefault(); if (!dragOver) setDragOver(true); }}
                onDragLeave={(e) => { e.preventDefault(); setDragOver(false); }}
                onDrop={onDrop}
              >
                <div className="drop-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4F46E5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                </div>
                <div className="drop-text">
                  <div className="drop-title">Drop a listing photo — JPG or PNG</div>
                  <div className="drop-sub">or click to browse</div>
                </div>
              </div>
            )}

            <label className="field-label">Caption <span className="field-optional">(optional)</span></label>
            <input
              className="caption-input"
              type="text"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="e.g. Vintage leather sofa, great condition"
            />

            <button className="run-btn" onClick={run} disabled={!file || status === 'loading'}>
              {status === 'loading' && <span className="run-spinner" />}
              <span>{status === 'loading' ? 'Running…' : 'Run moderation'}</span>
            </button>
            <div className="run-hint">Tests against marketplace listing policies.</div>
          </section>

          {/* RIGHT: OUTPUT */}
          <section className="panel output-panel">
            <div className="output-header">
              <span className="panel-label">Output</span>
              <div className="tabs">
                <button className={`tab${view === 'card' ? ' active' : ''}`} onClick={() => setView('card')}>Card</button>
                <button className={`tab tab-mono${view === 'json' ? ' active' : ''}`} onClick={() => setView('json')}>JSON</button>
              </div>
            </div>

            <div className="output-body">
              {status === 'empty' && (
                <div className="placeholder">
                  <div className="placeholder-icon">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                    </svg>
                  </div>
                  <div className="placeholder-text">Run a check to see the result.</div>
                </div>
              )}

              {status === 'loading' && (
                <div className="placeholder">
                  <span className="big-spinner" />
                  <div className="loading-text">running moderation…</div>
                </div>
              )}

              {status === 'not_photo' && (
                <div className="placeholder">
                  <div className="placeholder-icon" style={{ background: '#FEF3C7' }}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#B45309" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                  </div>
                  <div className="placeholder-text">{error}</div>
                </div>
              )}

              {status === 'error' && (
                <div className="placeholder">
                  <div className="placeholder-icon" style={{ background: '#FEE2E2' }}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#DC2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                  </div>
                  <div className="placeholder-text">{error}</div>
                </div>
              )}

              {status === 'done' && result && view === 'card' && (
                <div className="card-view">
                  {(() => { const vm = VERDICT[result.decision]; return (
                    <div className="verdict" style={{ borderColor: vm.border, background: vm.bg }}>
                      <div className="verdict-glyph" style={{ background: vm.color }}>{vm.glyph}</div>
                      <div>
                        <div className="verdict-label" style={{ color: vm.color }}>{vm.label}</div>
                        <div className="verdict-sub">{vm.sub}</div>
                      </div>
                    </div>
                  ); })()}

                  <div className="section">
                    <div className="section-label">Violations <span className="muted">({result.violations.length})</span></div>
                    {result.violations.length > 0 ? (
                      <div className="violation-list">
                        {result.violations.map((v, i) => (
                          <div className="violation" key={i}>
                            <span className="sev" style={{ color: SEV[v.severity].color, background: SEV[v.severity].bg }}>{v.severity}</span>
                            <div className="violation-body">
                              <div className="violation-rule">{v.rule}</div>
                              <div className="violation-exp">{v.explanation}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="no-violations"><span style={{ color: '#16A34A' }}>✓</span> No policy violations detected.</div>
                    )}
                  </div>

                  {result.advisory_flags.length > 0 && (
                    <div className="advisory">
                      <div className="advisory-label">Advisory <span className="advisory-note">· non-blocking</span></div>
                      <div className="advisory-list">
                        {result.advisory_flags.map((a, i) => (
                          <div className="advisory-item" key={i}>
                            <span className="advisory-dot" />
                            <div>
                              <span className="advisory-flag">{a.flag}</span>
                              <span className="advisory-exp"> — {a.explanation}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="metrics">
                    <div className="quality">
                      <div className="quality-top">
                        <span className="quality-label">Quality score</span>
                        <span className="quality-pct" style={{ color: qualityColor(result.quality_score) }}>{pct(result.quality_score)}/100</span>
                      </div>
                      <div className="quality-track">
                        <div className="quality-fill" style={{ width: `${pct(result.quality_score)}%`, background: qualityColor(result.quality_score) }} />
                      </div>
                    </div>
                    <div className="confidence">
                      <span className="confidence-dot" />
                      <span className="confidence-label">Confidence</span>
                      <span className="confidence-pct">{pct(result.confidence)}%</span>
                    </div>
                  </div>
                </div>
              )}

              {status === 'done' && result && view === 'json' && (
                <div className="json-wrap"><JsonView data={result} /></div>
              )}
            </div>

            {status === 'done' && (
              <div className="output-footer">
                <span className="ok"><span className="ok-dot" />200 OK</span>
                <span className="dot-sep">·</span>
                <span>{latencyMs != null ? `${(latencyMs / 1000).toFixed(1)}s` : '—'}</span>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
