import React, { useState } from 'react';
import { TelegramCall, TelegramStatus } from '../types';
import { ConditionBadge } from './ConditionBadge';
import { TelegramChannelManager } from './TelegramChannelManager';
import { Radio, Plus, Settings2 } from 'lucide-react';

interface TelegramFeedProps {
  calls: TelegramCall[];
  status?: TelegramStatus | null;
  onChannelsUpdated?: (updatedStatus: TelegramStatus) => void;
  onSelectCall: (call: TelegramCall) => void;
  onManualSnipe: (tokenAddress: string) => void;
}

export const TelegramFeed: React.FC<TelegramFeedProps> = ({
  calls,
  status,
  onChannelsUpdated,
  onSelectCall,
  onManualSnipe,
}) => {
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const [channelFilter, setChannelFilter] = useState<string>('ALL');
  const [showChannelManager, setShowChannelManager] = useState<boolean>(false);

  // Extract all unique channels from configured channels and received calls
  const availableChannels = React.useMemo(() => {
    const channelSet = new Set<string>();
    if (status?.channels && Array.isArray(status.channels)) {
      status.channels.forEach((ch) => {
        const clean = ch.replace('https://t.me/', '').replace('t.me/', '').replace('@', '').trim();
        if (clean) channelSet.add(clean);
      });
    }
    calls.forEach((c) => {
      if (c.channel) {
        const clean = c.channel.replace('https://t.me/', '').replace('t.me/', '').replace('@', '').trim();
        if (clean) channelSet.add(clean);
      }
      if (c.channels && Array.isArray(c.channels)) {
        c.channels.forEach((ch) => {
          const clean = ch.replace('https://t.me/', '').replace('t.me/', '').replace('@', '').trim();
          if (clean) channelSet.add(clean);
        });
      }
    });
    return Array.from(channelSet).filter((c) => !c.toLowerCase().includes('bullishcall'));
  }, [calls, status?.channels]);

  const copyToClipboard = (addr: string) => {
    navigator.clipboard.writeText(addr);
    setCopiedAddress(addr);
    setTimeout(() => setCopiedAddress(null), 2000);
  };

  const filteredCalls = React.useMemo(() => {
    const seen = new Set<string>();
    return calls.filter((c) => {
      if (!c || !c.id) return false;
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      if (channelFilter === 'ALL') return true;
      const lowerFilter = channelFilter.toLowerCase();
      const inPrimary = c.channel.toLowerCase().includes(lowerFilter);
      const inChannels = c.channels && c.channels.some((ch) => ch.toLowerCase().includes(lowerFilter));
      return inPrimary || inChannels;
    });
  }, [calls, channelFilter]);

  return (
    <div className="space-y-4">
      {/* Header & Filter Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-2 border-b border-zinc-900 gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-white tracking-wide font-mono uppercase">
            Telegram Live Signals
          </span>
          <span className="text-xs text-zinc-500 font-mono">
            ({filteredCalls.length} calls)
          </span>
        </div>

        {/* Channel Filter Pills & Management Button */}
        <div className="flex items-center gap-1.5 text-xs font-mono flex-wrap">
          <button
            onClick={() => setChannelFilter('ALL')}
            className={`px-2.5 py-1 rounded text-[11px] transition-colors ${
              channelFilter === 'ALL'
                ? 'bg-white text-black font-semibold'
                : 'bg-zinc-900 text-zinc-400 hover:text-white border border-zinc-800'
            }`}
          >
            Tous les Canaux
          </button>
          {availableChannels.map((clean) => (
            <button
              key={clean}
              onClick={() => setChannelFilter(clean)}
              className={`px-2.5 py-1 rounded text-[11px] transition-colors ${
                channelFilter === clean
                  ? 'bg-white text-black font-semibold'
                  : 'bg-zinc-900 text-zinc-400 hover:text-white border border-zinc-800'
              }`}
            >
              t.me/{clean}
            </button>
          ))}

          {/* Manage Channels Button */}
          <button
            type="button"
            onClick={() => setShowChannelManager(!showChannelManager)}
            className={`px-2.5 py-1 rounded text-[11px] font-semibold transition-colors flex items-center gap-1 cursor-pointer ${
              showChannelManager
                ? 'bg-emerald-400 text-black'
                : 'bg-zinc-900 hover:bg-zinc-800 text-emerald-400 border border-emerald-800/40'
            }`}
            title="Ajouter ou réduire les canaux Telegram surveillés"
          >
            <Settings2 className="w-3.5 h-3.5" />
            <span>{showChannelManager ? 'Masquer Gestionnaire' : `+ / - Canaux (${status?.channels?.length ?? availableChannels.length})`}</span>
          </button>
        </div>
      </div>

      {/* Dynamic Channel Management Panel */}
      {showChannelManager && (
        <div className="mb-2">
          <TelegramChannelManager
            status={status || null}
            onChannelsUpdated={onChannelsUpdated}
            compact={true}
          />
        </div>
      )}

      {/* Real-time sniper guarantee notice */}
      <div className="flex items-center gap-2 px-3 py-2 rounded bg-zinc-950/80 border border-zinc-900 text-[11px] font-mono text-zinc-400">
        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse flex-shrink-0" />
        <span>
          <strong className="text-white">Protection Nouveaux Calls :</strong> Le bot snipe exclusivement les <span className="text-emerald-400 font-semibold">nouveaux calls en direct</span> arrivant après son lancement. Les anciens messages rechargés au démarrage ou rafraîchissement sont automatiquement ignorés.
        </span>
      </div>

      {filteredCalls.length === 0 ? (
        <div className="p-8 text-center border border-dashed border-zinc-900 rounded bg-zinc-950/40">
          <p className="text-xs font-mono text-zinc-500 mb-1">
            Écoute en direct des alertes depuis t.me/pumpdotfunalert...
          </p>
          <p className="text-[11px] text-zinc-600">
            Dès qu'un token ou contrat (CA) est détecté dans le canal, le sniper applique instantanément les 7 règles d'audit GMGN.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredCalls.map((call, idx) => {
            const hasAnalysis = !!call.analysis;
            const isSniped = call.status === 'SNIPED' || call.analysis?.decision === 'SNIPED';
            const isAnalyzing = !call.analysis && (call.status === 'ANALYZING' || call.status === 'PENDING');
            const channelName = call.channel.replace('https://t.me/', '').replace('t.me/', '').replace('@', '');

            return (
              <div
                key={`${call.id}_${idx}`}
                className={`p-4 rounded border transition-all ${
                  isSniped
                    ? 'bg-zinc-950 border-white/40 shadow-sm'
                    : 'bg-black border-zinc-900 hover:border-zinc-800'
                }`}
              >
                {/* Top Row: Symbol, Source Channel Badge, Age, Decision Badge */}
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <span className="text-sm font-bold font-mono text-white">
                      ${call.tokenSymbol || 'TOKEN'}
                    </span>

                    {/* Fresh Live vs Historical Badge */}
                    {call.isHistorical ? (
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-900 text-zinc-500 border border-zinc-800" title="Call pré-existant chargé au démarrage (auto-snipe désactivé)">
                        Archive
                      </span>
                    ) : (
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-950/70 text-emerald-400 border border-emerald-800/80 flex items-center gap-1 font-semibold" title="Nouveau call reçu en direct (éligible auto-snipe)">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                        LIVE
                      </span>
                    )}

                    {/* Source Channel Pill */}
                    <a
                      href={`https://${call.channel}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-900 text-zinc-400 border border-zinc-800 hover:text-white"
                    >
                      {channelName}
                    </a>

                    {call.claimedMarketCap && (
                      <span className="text-[11px] font-mono text-zinc-400 bg-zinc-900/80 px-1.5 py-0.5 rounded border border-zinc-800">
                        MC: {call.claimedMarketCap}
                      </span>
                    )}
                    {call.claimedAge && (
                      <span className="text-[11px] font-mono text-zinc-500">
                        Age: {call.claimedAge}
                      </span>
                    )}
                    <span className="text-[10px] font-mono text-zinc-600">
                      {new Date(call.timestamp).toLocaleTimeString()}
                    </span>
                  </div>

                  {/* Status / Verdict Badge */}
                  <div>
                    {isAnalyzing ? (
                      <span className="px-2 py-0.5 text-xs font-mono rounded bg-zinc-900 text-amber-400 border border-amber-500/30 flex items-center gap-1.5 animate-pulse">
                        <span className="w-2 h-2 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                        ANALYZING GMGN...
                      </span>
                    ) : isSniped ? (
                      <span className="px-2 py-0.5 text-xs font-mono font-bold rounded bg-white text-black border border-white">
                        SNIPED
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 text-xs font-mono rounded bg-zinc-950 text-zinc-500 border border-zinc-800">
                        REJECTED
                      </span>
                    )}
                  </div>
                </div>

                {/* Contract Address row */}
                <div className="flex items-center gap-2 py-1.5 px-2 bg-zinc-950/70 border border-zinc-900 rounded text-xs font-mono mb-2.5">
                  <span className="text-zinc-500 text-[11px]">CA:</span>
                  <span className="text-zinc-300 select-all truncate flex-1">
                    {call.tokenAddress}
                  </span>
                  <button
                    onClick={() => copyToClipboard(call.tokenAddress)}
                    className="text-[11px] text-zinc-400 hover:text-white px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 hover:border-zinc-700"
                  >
                    {copiedAddress === call.tokenAddress ? 'COPIED' : 'COPY'}
                  </button>
                </div>

                {/* 7 Conditions Checklist */}
                {call.analysis?.conditions && (
                  <ConditionBadge conditions={call.analysis.conditions} />
                )}

                {/* Footer Actions & Links */}
                <div className="flex items-center justify-between gap-3 mt-3 pt-2.5 border-t border-zinc-900 text-xs font-mono flex-wrap">
                  <div className="flex items-center gap-3 text-[11px]">
                    <a
                      href={`https://dexscreener.com/solana/${call.tokenAddress}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-zinc-400 hover:text-white hover:underline"
                    >
                      Dexscreener ↗
                    </a>
                    <a
                      href={`https://gmgn.ai/sol/token/${call.tokenAddress}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-zinc-400 hover:text-white hover:underline"
                    >
                      GMGN ↗
                    </a>
                    <a
                      href={`https://solscan.io/token/${call.tokenAddress}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-zinc-500 hover:text-zinc-300"
                    >
                      Solscan ↗
                    </a>
                  </div>

                  <div className="flex items-center gap-2">
                    {hasAnalysis && (
                      <button
                        onClick={() => onSelectCall(call)}
                        className="px-2.5 py-1 text-[11px] font-mono rounded bg-zinc-900 text-zinc-300 hover:text-white hover:bg-zinc-800 border border-zinc-800"
                      >
                        FULL AUDIT
                      </button>
                    )}
                    {!isSniped && (
                      <button
                        onClick={() => onManualSnipe(call.tokenAddress)}
                        className="px-2.5 py-1 text-[11px] font-mono rounded bg-white text-black hover:bg-zinc-200 font-semibold"
                      >
                        MANUAL SNIPE
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
