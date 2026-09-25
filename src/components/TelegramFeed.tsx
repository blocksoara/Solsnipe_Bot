import React, { useState } from 'react';
import { TelegramCall, TelegramStatus } from '../types';
import { ConditionBadge } from './ConditionBadge';
import { TelegramChannelManager } from './TelegramChannelManager';
import { RugCheckBadge } from './RugCheckBadge';
import { Radio, Plus, Settings2, ShieldCheck, ShieldAlert, AlertTriangle } from 'lucide-react';

interface TelegramFeedProps {
  calls: TelegramCall[];
  status?: TelegramStatus | null;
  onChannelsUpdated?: (updatedStatus: TelegramStatus) => void;
  onSelectCall: (call: TelegramCall) => void;
  onManualSnipe: (tokenAddress: string) => void;
  onReanalyzeCall?: (call: TelegramCall) => void;
}

export const TelegramFeed: React.FC<TelegramFeedProps> = ({
  calls,
  status,
  onChannelsUpdated,
  onSelectCall,
  onManualSnipe,
  onReanalyzeCall,
}) => {
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const [channelFilter, setChannelFilter] = useState<string>('ALL');
  const [rugFilter, setRugFilter] = useState<'ALL' | 'SAFE' | 'WARN' | 'DANGER'>('ALL');
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

      // Channel Filter
      if (channelFilter !== 'ALL') {
        const lowerFilter = channelFilter.toLowerCase();
        const inPrimary = c.channel.toLowerCase().includes(lowerFilter);
        const inChannels = c.channels && c.channels.some((ch) => ch.toLowerCase().includes(lowerFilter));
        if (!inPrimary && !inChannels) return false;
      }

      // RugCheck Security Filter
      if (rugFilter !== 'ALL') {
        const rc = c.rugCheck || c.analysis?.rugCheck;
        if (!rc) return false;
        if (rugFilter === 'SAFE' && (rc.status !== 'good' || rc.score >= 500)) return false;
        if (rugFilter === 'WARN' && rc.status !== 'warn') return false;
        if (rugFilter === 'DANGER' && rc.status !== 'danger' && rc.score < 1000 && !rc.rugged) return false;
      }

      return true;
    });
  }, [calls, channelFilter, rugFilter]);

  // Count calls by RugCheck status for badge metrics
  const rugStats = React.useMemo(() => {
    let safe = 0;
    let warn = 0;
    let danger = 0;
    calls.forEach((c) => {
      const rc = c.rugCheck || c.analysis?.rugCheck;
      if (rc) {
        if (rc.rugged || rc.status === 'danger' || rc.score >= 1000) danger++;
        else if (rc.status === 'warn' || rc.score >= 500) warn++;
        else safe++;
      }
    });
    return { safe, warn, danger };
  }, [calls]);

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

      {/* RugCheck Security Score Quick Filters Bar */}
      <div className="flex items-center justify-between gap-2 p-2 rounded bg-zinc-950/80 border border-zinc-900 text-xs font-mono flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[11px] font-semibold text-zinc-400 flex items-center gap-1 mr-1">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
            <span>Filtre RugCheck :</span>
          </span>

          <button
            type="button"
            onClick={() => setRugFilter('ALL')}
            className={`px-2 py-0.5 rounded text-[11px] font-semibold transition-colors cursor-pointer ${
              rugFilter === 'ALL'
                ? 'bg-white text-black'
                : 'bg-zinc-900 text-zinc-400 hover:text-white border border-zinc-800'
            }`}
          >
            Tous ({calls.length})
          </button>

          <button
            type="button"
            onClick={() => setRugFilter('SAFE')}
            className={`px-2 py-0.5 rounded text-[11px] font-semibold transition-colors flex items-center gap-1 cursor-pointer ${
              rugFilter === 'SAFE'
                ? 'bg-emerald-500 text-black font-bold'
                : 'bg-emerald-950/40 text-emerald-400 hover:bg-emerald-950/70 border border-emerald-900/60'
            }`}
            title="Afficher uniquement les tokens avec score sain (< 500)"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            <span>Sécurisé / Bon ({rugStats.safe})</span>
          </button>

          <button
            type="button"
            onClick={() => setRugFilter('WARN')}
            className={`px-2 py-0.5 rounded text-[11px] font-semibold transition-colors flex items-center gap-1 cursor-pointer ${
              rugFilter === 'WARN'
                ? 'bg-amber-500 text-black font-bold'
                : 'bg-amber-950/40 text-amber-300 hover:bg-amber-950/70 border border-amber-900/60'
            }`}
            title="Tokens avec avertissement ou score modéré (500 - 1000)"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            <span>Attention ({rugStats.warn})</span>
          </button>

          <button
            type="button"
            onClick={() => setRugFilter('DANGER')}
            className={`px-2 py-0.5 rounded text-[11px] font-semibold transition-colors flex items-center gap-1 cursor-pointer ${
              rugFilter === 'DANGER'
                ? 'bg-rose-500 text-white font-bold'
                : 'bg-rose-950/40 text-rose-300 hover:bg-rose-950/70 border border-rose-900/60'
            }`}
            title="Tokens à haut risque ou avec flag danger (1000+ ou risques critiques)"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
            <span>Danger / Élevé ({rugStats.danger})</span>
          </button>
        </div>

        <div className="text-[10px] text-zinc-500">
          Analyse RugCheck.xyz on-chain temps réel
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

                {/* RugCheck Score Indicator & Security Analysis Layer */}
                <div className="flex items-center justify-between gap-2 mb-2 pb-2 border-b border-zinc-900/80 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap">
                    <RugCheckBadge
                      tokenAddress={call.tokenAddress}
                      rugCheck={call.rugCheck || call.analysis?.rugCheck}
                    />

                    {/* Launchpad Pill if available */}
                    {call.analysis?.rawMetrics?.launchpad && (
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-900 text-zinc-400 border border-zinc-800">
                        {String(call.analysis.rawMetrics.launchpad)}
                      </span>
                    )}

                    {/* Quick Risk Pill Summary */}
                    {(call.rugCheck || call.analysis?.rugCheck)?.risksCount !== undefined && (
                      <span className="text-[10px] font-mono text-zinc-500">
                        {(call.rugCheck || call.analysis?.rugCheck)?.risksCount === 0
                          ? '0 risque détecté'
                          : `${(call.rugCheck || call.analysis?.rugCheck)?.risksCount} risque(s)`}
                      </span>
                    )}
                  </div>

                  {/* Right side audit status tag */}
                  <div className="text-[11px] font-mono">
                    {(call.rugCheck || call.analysis?.rugCheck)?.status === 'good' ? (
                      <span className="text-emerald-400 text-[10px] font-semibold flex items-center gap-1">
                        <ShieldCheck className="w-3 h-3" />
                        <span>Sécurisé (&lt;500)</span>
                      </span>
                    ) : (call.rugCheck || call.analysis?.rugCheck)?.status === 'danger' ? (
                      <span className="text-rose-400 text-[10px] font-semibold flex items-center gap-1">
                        <ShieldAlert className="w-3 h-3" />
                        <span>Risque Critique</span>
                      </span>
                    ) : (call.rugCheck || call.analysis?.rugCheck)?.status === 'warn' ? (
                      <span className="text-amber-300 text-[10px] font-semibold flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" />
                        <span>Risque Modéré</span>
                      </span>
                    ) : null}
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
                    <button
                      onClick={() => (onReanalyzeCall ? onReanalyzeCall(call) : onSelectCall(call))}
                      className="px-2.5 py-1 text-[11px] font-mono rounded bg-zinc-900 text-zinc-300 hover:text-white hover:bg-zinc-800 border border-zinc-800"
                      title={hasAnalysis ? "Relancer l'audit multi-sources" : "Lancer l'audit"}
                    >
                      {hasAnalysis ? 'RE-AUDIT' : 'AUDIT'}
                    </button>
                    {hasAnalysis && (
                      <button
                        onClick={() => onSelectCall(call)}
                        className="px-2.5 py-1 text-[11px] font-mono rounded bg-zinc-900 text-zinc-300 hover:text-white hover:bg-zinc-800 border border-zinc-800"
                      >
                        DÉTAILS
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
