import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';

// Mirror of the server-side ModerationResult shape (src/lib/moderation.ts),
// kept inline so the component is self-contained on the client.
type Decision = 'pass' | 'fail';
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

type Status = 'empty' | 'loading' | 'streaming' | 'done' | 'error';
type View = 'card' | 'json';

const ACCEPT = 'image/png,image/jpeg';

// Map Seclai's raw model aliases to human-friendly labels for display. Falls
// back to auto-formatting (e.g. openai_gpt_4_1 → GPT-4.1) for unmapped aliases.
const MODEL_LABELS: Record<string, string> = {
  openai_gpt_5_5: 'GPT-5.5',
};
const modelLabel = (m: string) => {
  if (MODEL_LABELS[m]) return MODEL_LABELS[m];
  const g = m.match(/gpt_(\d+)_(\d+)/i);
  if (g) return `GPT-${g[1]}.${g[2]}`;
  return m;
};

const VERDICT = {
  pass: { color: '#16A34A', glyph: '✓', label: 'Pass', sub: 'Listing meets marketplace policies.', bg: 'rgba(22,163,74,0.07)', border: 'rgba(22,163,74,0.25)' },
  fail: { color: '#DC2626', glyph: '✕', label: 'Fail', sub: "Listing can't be published — see below.", bg: 'rgba(220,38,38,0.07)', border: 'rgba(220,38,38,0.25)' },
} as const;

// What the moderator checks for, shown in the UI so users know what
// to expect before they run something. Mirrors the system prompt in
// src/lib/moderation.ts.
type RuleTier = 'fail' | 'advisory';
const RULES: { rule: string; tier: RuleTier; label: string; examples: string }[] = [
  { rule: 'prohibited_item', tier: 'fail', label: 'Prohibited or restricted items', examples: 'weapons, drugs, recalled goods, counterfeits, adult content' },
  { rule: 'unsafe_or_graphic', tier: 'fail', label: 'Unsafe or graphic content', examples: 'gore, violence, hazardous materials' },
  { rule: 'contact_info_in_image', tier: 'fail', label: 'Contact info shown in the photo', examples: 'phone numbers, emails, URLs, handles' },
  { rule: 'third_party_watermark', tier: 'fail', label: 'Third-party or retailer watermarks', examples: 'logos from other marketplaces or stock sites' },
  { rule: 'misleading_or_stock', tier: 'fail', label: 'Stock / misleading imagery', examples: 'product render or web-pulled image used as the actual item' },
  { rule: 'not_a_listing_photo', tier: 'fail', label: 'Not a listing photo', examples: 'memes, screenshots, selfies — short-circuits with an error' },
  { rule: 'low_quality_photo', tier: 'advisory', label: 'Image quality', examples: 'lighting, focus, framing' },
  { rule: 'possibly_ai_generated', tier: 'advisory', label: 'AI-generated or unusual artifacts', examples: 'flagged as a note — does not fail on its own' },
];
const RULE_TIER = {
  fail: { color: '#DC2626', bg: 'rgba(220,38,38,0.10)', label: 'Fails' },
  advisory: { color: '#64748B', bg: 'rgba(100,116,139,0.10)', label: 'Note' },
} as const;

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

export default function ListingModerator() {
  const [status, setStatus] = useState<Status>('empty');
  const [view, setView] = useState<View>('card');
  const [checksOpen, setChecksOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [caption, setCaption] = useState('');
  const [result, setResult] = useState<ModerationResult | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [streamText, setStreamText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const copyJson = useCallback(async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(result, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — ignore */
    }
  }, [result]);

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  useEffect(() => {
    if (!checksOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setChecksOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [checksOpen]);

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
    setStreamText('');
  }, []);

  const onDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    setImage(e.dataTransfer.files?.[0]);
  }, [setImage]);

  const run = useCallback(async () => {
    if (!file || status === 'loading' || status === 'streaming') return;
    setStatus('loading');
    setError(null);
    setResult(null);
    setStreamText('');
    try {
      const body = new FormData();
      body.append('image', file);
      if (caption.trim()) body.append('caption', caption.trim());
      const res = await fetch('/api/moderate', { method: 'POST', body });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `Request failed (${res.status}).`);
      }

      // Parse the Server-Sent Events stream.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let acc = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const blocks = buf.split('\n\n');
        buf = blocks.pop() ?? '';
        for (const block of blocks) {
          if (!block.trim()) continue;
          let event = 'message';
          let dataStr = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
          }
          let data: any;
          try { data = JSON.parse(dataStr); } catch { continue; }
          if (event === 'token') {
            acc += data.token ?? '';
            setStreamText(acc);
            setStatus('streaming');
            setView('json');
          } else if (event === 'result') {
            setResult(data.result as ModerationResult);
            setLatencyMs(typeof data.latencyMs === 'number' ? data.latencyMs : null);
            setModel(typeof data.model === 'string' ? data.model : null);
            setView('card');
            setStatus('done');
          } else if (event === 'error') {
            throw new Error(data.error || 'Moderation failed.');
          }
        }
      }
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
          <span className="brand-title">Listing Moderator</span>
          <a
            className="brand-pill"
            href="https://seclai.com"
            target="_blank"
            rel="noopener noreferrer"
            title="Learn more about Seclai"
          >
            powered by Seclai
          </a>
        </div>
        <div className="topbar-actions">
        <button
          className={`gh-btn checks-btn${checksOpen ? ' active' : ''}`}
          onClick={() => setChecksOpen((v) => !v)}
          aria-label="What the moderator checks"
          aria-expanded={checksOpen}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
          <span>What's checked</span>
        </button>
        <a
          className="gh-btn"
          href="https://github.com/seclai/demos/tree/main/listing-moderator"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="View source on GitHub"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
          </svg>
          <span>GitHub</span>
        </a>
        </div>
      </header>

      {/* HERO */}
      <section className="hero">
        <h1 className="hero-title">Catch bad listings before buyers do</h1>
        <p className="hero-sub">Moderates a marketplace listing in seconds. A vision agent checks the photo for prohibited items, contact info, watermarks, stock or AI-generated images, and quality — then returns structured JSON your backend can act on.</p>
      </section>

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
                  <div className="drop-title">Drag a listing photo here, or click to upload</div>
                  <div className="drop-sub">JPG or PNG</div>
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
            <div className="field-helper">The agent cross-checks your caption against the photo — mismatches show up as advisory flags.</div>

            <button className="run-btn" onClick={run} disabled={!file || status === 'loading' || status === 'streaming'}>
              {(status === 'loading' || status === 'streaming') && <span className="run-spinner" />}
              <span>{status === 'loading' || status === 'streaming' ? 'Running…' : 'Run moderation'}</span>
            </button>
            <div className="run-hint">Checks prohibited items, contact info in images, watermarks, stock photos, and image quality.</div>
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
                  <div className="placeholder-text">Upload a listing on the left to see a verdict, any policy violations, and the raw JSON your backend would receive.</div>
                  <button className="checks-open-link" onClick={() => setChecksOpen(true)}>See what the moderator checks →</button>
                </div>
              )}

              {status === 'loading' && (
                <div className="placeholder">
                  <span className="big-spinner" />
                  <div className="loading-text">running moderation…</div>
                </div>
              )}

              {status === 'streaming' && (
                <div className="json-wrap">
                  <div className="json"><span className="json-line">{streamText}<span className="stream-caret" /></span></div>
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
                    {result.violations.length > 0 ? (
                      <>
                        <div className="section-label">Why it failed <span className="muted">({result.violations.length})</span></div>
                        <div className="violation-list">
                          {result.violations.map((v, i) => (
                            <div className="violation" key={i}>
                              <span className="violation-dot" />
                              <div className="violation-body">
                                <div className="violation-rule">{v.rule}</div>
                                <div className="violation-exp">{v.explanation}</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </>
                    ) : (
                      <div className="no-violations"><span style={{ color: '#16A34A' }}>✓</span> No policy violations detected.</div>
                    )}
                  </div>

                  {result.advisory_flags.length > 0 && (
                    <div className="advisory">
                      <div className="advisory-label">Noted <span className="advisory-note">· doesn't fail</span></div>
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
                </div>
              )}

              {status === 'done' && result && view === 'json' && (
                <div className="json-wrap">
                  <button className="json-copy" onClick={copyJson} aria-label="Copy JSON">
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                  <JsonView data={result} />
                </div>
              )}
            </div>

            {status === 'done' && (
              <div className="output-footer">
                <span className="ok"><span className="ok-dot" />200 OK</span>
                <span className="dot-sep">·</span>
                <span>{latencyMs != null ? `${(latencyMs / 1000).toFixed(1)}s` : '—'}</span>
                {model && (<><span className="dot-sep">·</span><span>{modelLabel(model)}</span></>)}
                <button className="footer-clear" onClick={clearImage}>Clear</button>
              </div>
            )}
          </section>
        </div>
      </main>

      {/* CHECKS DRAWER */}
      <div
        className={`drawer-backdrop${checksOpen ? ' open' : ''}`}
        onClick={() => setChecksOpen(false)}
        aria-hidden="true"
      />
      <aside className={`drawer${checksOpen ? ' open' : ''}`} role="dialog" aria-label="What the moderator checks" aria-modal={checksOpen}>
        <div className="drawer-head">
          <div>
            <div className="drawer-title">What the moderator checks</div>
            <div className="drawer-sub">A listing passes or fails based on the rules below.</div>
          </div>
          <button className="drawer-close" onClick={() => setChecksOpen(false)} aria-label="Close">✕</button>
        </div>
        <div className="drawer-body">
          <p className="drawer-legend">
            <strong>Fails</strong> if <strong>any</strong> of these are found. <strong>Passes</strong> if
            none are. Advisory items are noted but never fail on their own.
          </p>
          {([
            { tier: 'fail' as RuleTier, heading: 'Fails the listing' },
            { tier: 'advisory' as RuleTier, heading: 'Noted but still passes' },
          ]).map(({ tier, heading }) => (
            <div className="drawer-group" key={tier}>
              <div className="drawer-group-head">{heading}</div>
              <div className="drawer-list">
                {RULES.filter((r) => r.tier === tier).map((r) => {
                  const t = RULE_TIER[r.tier];
                  return (
                    <div className="check" key={r.rule}>
                      <span className="check-tier" style={{ color: t.color, background: t.bg }}>{t.label}</span>
                      <div className="check-body">
                        <div className="check-top">
                          <span className="check-label">{r.label}</span>
                          <span className="check-id">{r.rule}</span>
                        </div>
                        <div className="check-examples">{r.examples}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
