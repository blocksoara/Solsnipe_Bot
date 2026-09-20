import React from 'react';
import { GMGNAnalysisReport, TelegramCall } from '../types';

interface AnalysisModalProps {
  call: TelegramCall | null;
  onClose: () => void;
  onManualSnipe: (tokenAddress: string) => void;
}

export const AnalysisModal: React.FC<AnalysisModalProps> = ({
  call,
  onClose,
  onManualSnipe,
}) => {
  if (!call || !call.analysis) return null;

  const r: GMGNAnalysisReport = call.analysis;
  const isSniped = r.decision === 'SNIPED';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="bg-zinc-950 border border-zinc-800 rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto p-5 space-y-4 text-xs font-mono shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between pb-3 border-b border-zinc-800">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-bold text-white font-mono uppercase">
                ${r.tokenSymbol} Analysis
              </h3>
              <span
                className={`px-2 py-0.5 rounded text-[11px] font-bold uppercase ${
                  isSniped
                    ? 'bg-white text-black'
                    : 'bg-zinc-900 text-zinc-400 border border-zinc-800'
                }`}
              >
                {r.decision}
              </span>
            </div>
            <p className="text-zinc-500 text-[11px] mt-0.5 select-all">
              CA: {r.tokenAddress}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-white px-2 py-1 rounded bg-zinc-900 border border-zinc-800"
          >
            ESC / CLOSE
          </button>
        </div>

        {/* 7 Conditions Checklist Detailed */}
        <div>
          <h4 className="text-zinc-400 font-semibold mb-2 uppercase text-[11px]">
            Sniper Rule Evaluation (7 Mandatory Conditions)
          </h4>
          <div className="space-y-2">
            {r.conditions.map((c, index) => (
              <div
                key={c.id}
                className={`p-3 rounded border flex flex-col gap-1 ${
                  c.passed
                    ? 'bg-zinc-900/40 border-white/20 text-zinc-300'
                    : 'bg-zinc-950 border-zinc-800 text-zinc-500'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-white">
                    {index + 1}. {c.name}
                  </span>
                  <span
                    className={`px-1.5 py-0.2 text-[10px] font-bold rounded ${
                      c.passed ? 'bg-white text-black' : 'bg-zinc-900 text-zinc-500'
                    }`}
                  >
                    {c.passed ? 'PASS' : 'REJECT'}
                  </span>
                </div>
                <div className="text-[11px] text-zinc-400">
                  <strong>Rule:</strong> {c.rule}
                </div>
                <div className="text-[11px] text-zinc-300">
                  <strong>Measured:</strong> {c.details}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Metrics Grid */}
        <div>
          <h4 className="text-zinc-400 font-semibold mb-2 uppercase text-[11px]">
            On-Chain Fundamentals & Market Intelligence
          </h4>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <div className="p-2.5 rounded bg-black border border-zinc-900">
              <span className="text-[10px] text-zinc-500 block">TOP 10 HOLDERS</span>
              <span className="text-white font-bold">{r.top10HoldersPercent.toFixed(1)}%</span>
            </div>
            <div className="p-2.5 rounded bg-black border border-zinc-900">
              <span className="text-[10px] text-zinc-500 block">MARKET CAP</span>
              <span className="text-white font-bold">${formatNum(r.marketCapUsd)}</span>
            </div>
            <div className="p-2.5 rounded bg-black border border-zinc-900">
              <span className="text-[10px] text-zinc-500 block">24H VOLUME</span>
              <span className="text-white font-bold">${formatNum(r.volume24hUsd)}</span>
            </div>
            <div className="p-2.5 rounded bg-black border border-zinc-900">
              <span className="text-[10px] text-zinc-500 block">BUYERS / SELLERS</span>
              <span className="text-white font-bold">{r.buyersCount} / {r.sellersCount}</span>
            </div>
            <div className="p-2.5 rounded bg-black border border-zinc-900">
              <span className="text-[10px] text-zinc-500 block">KOL WALLETS</span>
              <span className="text-white font-bold">{r.kolCount} detected</span>
            </div>
            <div className="p-2.5 rounded bg-black border border-zinc-900">
              <span className="text-[10px] text-zinc-500 block">SMART MONEY</span>
              <span className="text-white font-bold">{r.smartWalletCount} wallets</span>
            </div>
          </div>
        </div>

        {/* Links & Socials */}
        <div className="p-3 rounded bg-black border border-zinc-900 space-y-1.5 text-[11px]">
          <span className="text-zinc-500 block uppercase font-semibold">Social & Verification Links:</span>
          <div className="flex flex-wrap gap-3">
            {r.websiteUrl ? (
              <a href={r.websiteUrl} target="_blank" rel="noopener noreferrer" className="text-zinc-300 hover:text-white underline">
                Website ↗
              </a>
            ) : (
              <span className="text-zinc-600">No Website</span>
            )}
            {r.twitterUrl ? (
              <a href={r.twitterUrl.startsWith('http') ? r.twitterUrl : `https://x.com/${r.twitterUrl}`} target="_blank" rel="noopener noreferrer" className="text-zinc-300 hover:text-white underline">
                Twitter/X ↗
              </a>
            ) : (
              <span className="text-zinc-600">No Twitter</span>
            )}
            {r.telegramUrl ? (
              <a href={r.telegramUrl.startsWith('http') ? r.telegramUrl : `https://t.me/${r.telegramUrl}`} target="_blank" rel="noopener noreferrer" className="text-zinc-300 hover:text-white underline">
                Telegram ↗
              </a>
            ) : (
              <span className="text-zinc-600">No Telegram</span>
            )}
            <a href={`https://dexscreener.com/solana/${r.tokenAddress}`} target="_blank" rel="noopener noreferrer" className="text-zinc-400 hover:text-white underline">
              Dexscreener ↗
            </a>
            <a href={`https://gmgn.ai/sol/token/${r.tokenAddress}`} target="_blank" rel="noopener noreferrer" className="text-zinc-400 hover:text-white underline">
              GMGN.ai ↗
            </a>
          </div>
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-between pt-3 border-t border-zinc-800">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded bg-zinc-900 text-zinc-400 hover:text-white border border-zinc-800"
          >
            Close
          </button>

          <button
            onClick={() => {
              onManualSnipe(r.tokenAddress);
              onClose();
            }}
            className="px-5 py-2 rounded bg-white text-black font-semibold hover:bg-zinc-200"
          >
            Snipe This Token Now
          </button>
        </div>
      </div>
    </div>
  );
};

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(2);
}
