import type { ChatExchange } from '../lib/types';
import { VerdictBadge } from './VerdictBadge';

interface Props {
  exchange: ChatExchange;
  isLoading?: boolean;
}

export function ChatMessage({ exchange, isLoading }: Props) {
  return (
    <div className="space-y-3">
      {/* User message */}
      <div className="flex justify-end">
        <div className="max-w-[80%] bg-accent/10 border border-accent/20 rounded-lg px-4 py-3">
          <p className="text-sm font-mono text-text-primary whitespace-pre-wrap">{exchange.userMessage}</p>
        </div>
      </div>

      {/* Bot response */}
      <div className="flex justify-start">
        <div className="max-w-[80%] bg-surface-raised border border-border rounded-lg px-4 py-3 space-y-2">
          {isLoading ? (
            <div className="flex items-center gap-2 text-text-secondary text-sm">
              <span className="inline-block w-2 h-2 bg-accent rounded-full animate-pulse" />
              <span className="inline-block w-2 h-2 bg-accent rounded-full animate-pulse [animation-delay:0.2s]" />
              <span className="inline-block w-2 h-2 bg-accent rounded-full animate-pulse [animation-delay:0.4s]" />
            </div>
          ) : (
            <>
              {exchange.verdict === 'Defended' ? (
                <div className="flex items-start gap-2 text-sm text-text-secondary italic">
                  <span aria-hidden className="text-accent">🛡️</span>
                  <p className="whitespace-pre-wrap">
                    Response withheld by Seclai governance before reaching you.
                  </p>
                </div>
              ) : (
                <p className="text-sm text-text-primary whitespace-pre-wrap">{exchange.botResponse}</p>
              )}
              <div className="flex items-center gap-3 pt-1">
                <VerdictBadge verdict={exchange.verdict} />
                {exchange.reasoning && (
                  <p className="text-xs text-text-secondary italic">{exchange.reasoning}</p>
                )}
              </div>
              {exchange.attemptId && (
                <p className="text-xs text-text-secondary font-mono pt-1">
                  🔗 <a href={`/api/attempt/${exchange.attemptId}`} className="underline hover:text-accent transition-colors">
                    Share this jailbreak
                  </a>
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
