import type { Verdict } from '../lib/types';

const colors: Record<Verdict, { bg: string; text: string; label: string }> = {
  Defended: { bg: 'bg-verdict-defended/15', text: 'text-verdict-defended', label: '🛡 Defended' },
  Safe: { bg: 'bg-verdict-safe/15', text: 'text-verdict-safe', label: '✓ Safe' },
  Broken: { bg: 'bg-verdict-broken/15', text: 'text-verdict-broken', label: '💥 Broken' },
};

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const c = colors[verdict];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded font-mono text-xs font-medium ${c.bg} ${c.text}`}>
      {c.label}
    </span>
  );
}
