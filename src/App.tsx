import React, { useEffect, useState } from 'react';
import { ActivePositions } from './components/ActivePositions';
import { AnalysisModal } from './components/AnalysisModal';
import { Header } from './components/Header';
import { ManualAnalyzer } from './components/ManualAnalyzer';
import { SniperSettings } from './components/SniperSettings';
import { TelegramFeed } from './components/TelegramFeed';
import { TradeHistory } from './components/TradeHistory';
import {
  ActivePosition,
  SniperConfig,
  TelegramCall,
  TelegramStatus,
  TradeHistoryItem,
} from './types';

const DEFAULT_CONFIG: SniperConfig = {
  autoSnipe: true,
  tradingAmountSol: 0.1,
  takeProfitPercent: 50,
  stopLossPercent: 15,
  trailingStopPercent: 10,
  slippagePercent: 5,
  router: 'jupiter',
  executionMode: 'simulation',
  priorityFeeSol: 0.005,
  jitoTipSol: 0.005,
  walletPublicKey: '',
  hasPrivateKey: false,
};

const getStoredConfig = (): SniperConfig => {
  try {
    const raw = localStorage.getItem('solana_sniper_config');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return { ...DEFAULT_CONFIG, ...parsed };
      }
    }
  } catch {}
  return DEFAULT_CONFIG;
};

export default function App() {
  const [calls, setCalls] = useState<TelegramCall[]>([]);
  const [positions, setPositions] = useState<ActivePosition[]>([]);
  const [history, setHistory] = useState<TradeHistoryItem[]>([]);
  const [telegramStatus, setTelegramStatus] = useState<TelegramStatus | null>(null);
  const [selectedCall, setSelectedCall] = useState<TelegramCall | null>(null);
  const [activeTab, setActiveTab] = useState<'stream' | 'positions' | 'history' | 'settings'>('stream');
  const [isManualAnalyzing, setIsManualAnalyzing] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const [config, setConfig] = useState<SniperConfig>(getStoredConfig);

  const saveConfig = (newCfg: SniperConfig) => {
    setConfig(newCfg);
    try {
      localStorage.setItem('solana_sniper_config', JSON.stringify(newCfg));
    } catch {}
  };

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 4000);
  };

  // Initial Data Hydration with resilient fetching and auto-retry
  const fetchData = async (retries = 3, delayMs = 1000): Promise<void> => {
    const fetchSafe = async (url: string) => {
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    };

    try {
      const [callsData, posData, histData, configData, statusData] = await Promise.all([
        fetchSafe('/api/calls'),
        fetchSafe('/api/positions'),
        fetchSafe('/api/history'),
        fetchSafe('/api/config'),
        fetchSafe('/api/status'),
      ]);

      if (callsData) {
        const incomingCalls = (callsData.calls || []) as TelegramCall[];
        const seenAddrs = new Set<string>();
        const uniqueCalls = incomingCalls.filter((c) => {
          if (!c || !c.tokenAddress) return false;
          const lower = c.tokenAddress.toLowerCase();
          if (seenAddrs.has(lower)) return false;
          seenAddrs.add(lower);
          return true;
        });
        setCalls(uniqueCalls);
        if (callsData.status) setTelegramStatus(callsData.status);
      }

      if (posData) {
        const incomingPos = (posData.positions || []) as ActivePosition[];
        const seen = new Set<string>();
        const uniquePos = incomingPos.filter((p) => {
          if (!p || !p.id || seen.has(p.id)) return false;
          seen.add(p.id);
          return true;
        });
        setPositions(uniquePos);
      }

      if (histData) {
        const incomingHist = (histData.history || []) as TradeHistoryItem[];
        const seen = new Set<string>();
        const uniqueHist = incomingHist.filter((h) => {
          if (!h || !h.id || seen.has(h.id)) return false;
          seen.add(h.id);
          return true;
        });
        setHistory(uniqueHist);
      }

      if (configData) {
        saveConfig(configData);
      }

      if (statusData && statusData.telegram) {
        setTelegramStatus(statusData.telegram);
      }

      // If all responses were null (e.g. server starting up), retry gently
      const anyLoaded = !!(callsData || posData || histData || configData || statusData);
      if (!anyLoaded && retries > 0) {
        setTimeout(() => fetchData(retries - 1, delayMs * 1.5), delayMs);
      }
    } catch (err) {
      if (retries > 0) {
        setTimeout(() => fetchData(retries - 1, delayMs * 1.5), delayMs);
      }
    }
  };

  useEffect(() => {
    fetchData();

    // Setup SSE stream for real-time live events
    const eventSource = new EventSource('/api/stream');

    eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);

        switch (payload.type) {
          case 'CALL_DETECTED': {
            setCalls((prev) => {
              // Avoid duplicate by id or tokenAddress
              const exists = prev.some(
                (c) => c.id === payload.data.id || c.tokenAddress === payload.data.tokenAddress
              );
              if (exists) return prev;
              return [payload.data, ...prev];
            });
            showToast(`New signal: ${payload.data.tokenSymbol || 'Token'} detected`);
            break;
          }
          case 'CALL_ANALYZED': {
            setCalls((prev) => {
              const targetId = payload.data.id;
              const hasDirectId = prev.some((c) => c.id === targetId);

              if (hasDirectId) {
                return prev.map((c) => (c.id === targetId ? payload.data : c));
              }

              // If matching by tokenAddress, only update the first match and preserve its unique id
              let updated = false;
              const updatedList = prev.map((c) => {
                if (!updated && c.tokenAddress === payload.data.tokenAddress) {
                  updated = true;
                  return {
                    ...payload.data,
                    id: c.id, // Preserve original unique id to prevent React duplicate key collisions
                  };
                }
                return c;
              });

              if (!updated) {
                return [payload.data, ...prev];
              }
              return updatedList;
            });
            if (payload.data.status === 'SNIPED') {
              showToast(`🎯 GMGN Approved: $${payload.data.tokenSymbol} matched all 7 rules!`);
            }
            break;
          }
          case 'SNIPE_EXECUTED': {
            setPositions((prev) => {
              const exists = prev.some((p) => p.id === payload.data.id);
              if (exists) return prev;
              return [payload.data, ...prev];
            });
            showToast(`🚀 SNIPED: $${payload.data.tokenSymbol} opened with ${payload.data.amountSol} SOL`);
            break;
          }
          case 'POSITIONS_UPDATED': {
            const incomingPos = (payload.data || []) as ActivePosition[];
            const seen = new Set<string>();
            setPositions(
              incomingPos.filter((p) => {
                if (!p || !p.id || seen.has(p.id)) return false;
                seen.add(p.id);
                return true;
              })
            );
            break;
          }
          case 'TRADE_EXECUTED': {
            setHistory((prev) => {
              if (prev.some((t) => t.id === payload.data.id)) return prev;
              return [payload.data, ...prev];
            });
            showToast(`Closed trade for $${payload.data.tokenSymbol}: ${payload.data.exitReason}`);
            break;
          }
          case 'CONFIG_UPDATED': {
            saveConfig(payload.data);
            break;
          }
          case 'STATUS_UPDATED': {
            if (payload.data) {
              setTelegramStatus(payload.data);
            }
            break;
          }
          default:
            break;
        }
      } catch (err) {
        console.error('SSE parse error:', err);
      }
    };

    eventSource.onerror = () => {
      // Reconnection handled automatically by browser EventSource
    };

    // Periodic poll fallback every 2.5 seconds for maximum real-time reliability
    const pollInterval = setInterval(() => {
      // 1. Sync active positions
      fetch('/api/positions')
        .then((r) => r.json())
        .then((d) => setPositions(d.positions || []))
        .catch(() => {});

      // 2. Sync calls and their GMGN analysis verdicts
      fetch('/api/calls')
        .then((r) => r.json())
        .then((d) => {
          if (d.calls && Array.isArray(d.calls)) {
            const incoming = d.calls as TelegramCall[];
            setCalls((prev) => {
              const prevIds = new Set(prev.map((c) => c.id));
              const prevAddrs = new Set(prev.map((c) => c.tokenAddress));

              // Update existing items with fresh analysis and status
              const updated = prev.map((c) => {
                const fresh = incoming.find(
                  (x) => x.id === c.id || x.tokenAddress === c.tokenAddress
                );
                return fresh ? { ...fresh, id: c.id } : c;
              });

              // Prepend any new calls detected on server
              const newItems = incoming.filter(
                (c) => !prevIds.has(c.id) && !prevAddrs.has(c.tokenAddress)
              );

              return [...newItems, ...updated];
            });

            if (d.status) {
              setTelegramStatus(d.status);
            }
          }
        })
        .catch(() => {});
    }, 2500);

    return () => {
      eventSource.close();
      clearInterval(pollInterval);
    };
  }, []);

  const handleToggleAutoSnipe = async () => {
    const updated = !config.autoSnipe;
    const optimistic = { ...config, autoSnipe: updated };
    saveConfig(optimistic);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoSnipe: updated }),
      });
      if (res.ok) {
        const data = await res.json();
        saveConfig(data);
        showToast(updated ? 'Auto-Sniper ACTIVATED' : 'Auto-Sniper PAUSED');
      }
    } catch (err) {
      console.error('Config update error:', err);
    }
  };

  const handleUpdateConfig = async (newConfig: Partial<SniperConfig>) => {
    const optimistic = { ...config, ...newConfig };
    saveConfig(optimistic);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newConfig),
      });
      if (res.ok) {
        const data = await res.json();
        saveConfig(data);
        showToast('Sniper settings updated successfully');
      }
    } catch (err) {
      console.error('Config update error:', err);
    }
  };

  const handleManualAnalyze = async (tokenAddress: string) => {
    setIsManualAnalyzing(true);
    try {
      const res = await fetch('/api/manual-analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokenAddress }),
      });
      if (res.ok) {
        const report = await res.json();
        showToast(`Audit Complete: ${report.decision} (${report.tokenSymbol})`);
        fetchData();
      } else {
        const err = await res.json();
        showToast(`Audit failed: ${err.error || 'Check token address'}`);
      }
    } catch (err: any) {
      showToast(`Error auditing token: ${err.message}`);
    } finally {
      setIsManualAnalyzing(false);
    }
  };

  const handleManualSnipe = async (tokenAddress: string) => {
    try {
      const res = await fetch('/api/manual-snipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokenAddress }),
      });
      if (res.ok) {
        const data = await res.json();
        showToast(`Manual Snipe triggered for ${tokenAddress.slice(0, 8)}...`);
        fetchData();
      } else {
        const err = await res.json();
        showToast(`Snipe failed: ${err.error}`);
      }
    } catch (err: any) {
      showToast(`Snipe error: ${err.message}`);
    }
  };

  const handleSellPosition = async (positionId: string, percent: number) => {
    try {
      const res = await fetch('/api/sell-position', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positionId, percent, reason: `Manual Sell (${percent}%)` }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        if (data.trade) {
          showToast(`Order Executed: Sold ${percent}% of ${data.trade.tokenSymbol}`);
          setHistory((prev) => [data.trade, ...prev]);
        } else {
          showToast(`Position settled: ${data.message || 'Closed'}`);
        }
        if (percent >= 100) {
          setPositions((prev) => prev.filter((p) => p.id !== positionId && p.tokenAddress !== positionId));
        }
        fetchData();
      } else {
        setPositions((prev) => prev.filter((p) => p.id !== positionId && p.tokenAddress !== positionId));
        showToast(data.message || data.error || 'Position closed');
        fetchData();
      }
    } catch (err: any) {
      console.error('Sell error:', err);
      showToast(`Sell error: ${err.message || 'Network issue'}`);
    }
  };

  const handleUpdatePositionTargets = async (
    positionId: string,
    targets: { tpPercent?: number; slPercent?: number; trailingStopPercent?: number }
  ) => {
    try {
      const res = await fetch('/api/position/update-targets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positionId, ...targets }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showToast('🎯 Objectifs de la position mis à jour');
        setPositions((prev) =>
          prev.map((p) => (p.id === positionId ? { ...p, ...data.position } : p))
        );
      } else {
        showToast(`Erreur: ${data.error || 'Impossible de mettre à jour'}`);
      }
    } catch (err: any) {
      showToast(`Erreur: ${err.message}`);
    }
  };

  const handleRequestTelegramCode = async (phone?: string) => {
    try {
      const res = await fetch('/api/telegram/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      const data = await res.json();
      if (data.success) {
        showToast(data.message || 'Code Telegram envoyé avec succès !');
      } else {
        showToast(`Erreur Telegram : ${data.message || 'Impossible d\'envoyer le code'}`);
      }
      return data;
    } catch (err: any) {
      showToast(`Erreur réseau : ${err.message}`);
      return { success: false, message: err.message };
    }
  };

  const handleVerifyTelegramCode = async (code: string, password?: string) => {
    try {
      const res = await fetch('/api/telegram/verify-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, password }),
      });
      const data = await res.json();
      if (data.success) {
        showToast('✓ Compte Telegram connecté avec succès !');
      } else {
        showToast(`Erreur validation : ${data.message || 'Code invalide'}`);
      }
      return data;
    } catch (err: any) {
      showToast(`Erreur réseau : ${err.message}`);
      return { success: false, message: err.message };
    }
  };

  const handleDisconnectTelegram = async () => {
    try {
      const res = await fetch('/api/telegram/disconnect', { method: 'POST' });
      const data = await res.json();
      showToast('Compte Telegram déconnecté');
      return data;
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  };

  const handleImportPrivateKey = async (pk: string) => {
    try {
      const res = await fetch('/api/wallet/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ privateKey: pk }),
      });
      const data = await res.json();
      if (data.success) {
        setConfig((prev) => ({
          ...prev,
          walletPublicKey: data.publicKey || prev.walletPublicKey,
          hasPrivateKey: true,
          walletBalanceSol: data.balanceSol !== undefined ? data.balanceSol : prev.walletBalanceSol,
        }));
        showToast('✓ Portefeuille Solana importé avec succès !');
      } else {
        showToast(`Erreur import : ${data.message}`);
      }
      return data;
    } catch (err: any) {
      showToast(`Erreur réseau : ${err.message}`);
      return { success: false, message: err.message };
    }
  };

  const handleRefreshBalance = async () => {
    try {
      const res = await fetch('/api/wallet/refresh-balance', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setConfig((prev) => ({
          ...prev,
          walletBalanceSol: data.balanceSol,
        }));
        showToast(`Solde actualisé : ${data.balanceSol} SOL`);
      }
    } catch (err: any) {
      showToast(`Erreur : ${err.message}`);
    }
  };

  const totalPnlUsd = positions.reduce((acc, p) => acc + (p.pnlUsd || 0), 0);

  return (
    <div className="min-h-screen bg-black text-zinc-100 selection:bg-white selection:text-black">
      {/* Top Header */}
      <Header
        status={telegramStatus}
        config={config}
        onToggleAutoSnipe={handleToggleAutoSnipe}
        activePositionsCount={positions.length}
        totalCallsCount={calls.length}
        totalPnlUsd={totalPnlUsd}
        onOpenSettings={() => setActiveTab('settings')}
      />

      {/* Main Content Container */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Navigation Tabs Bar */}
        <div className="flex items-center justify-between border-b border-zinc-900 pb-3 flex-wrap gap-2">
          <div className="flex items-center gap-1 sm:gap-2">
            <button
              onClick={() => setActiveTab('stream')}
              className={`px-3.5 py-1.5 text-xs font-mono font-semibold rounded uppercase tracking-wider transition-colors cursor-pointer ${
                activeTab === 'stream'
                  ? 'bg-white text-black'
                  : 'bg-zinc-950 text-zinc-400 hover:text-white border border-zinc-900'
              }`}
            >
              Signal Feed ({calls.length})
            </button>
            <button
              onClick={() => setActiveTab('positions')}
              className={`px-3.5 py-1.5 text-xs font-mono font-semibold rounded uppercase tracking-wider transition-colors cursor-pointer ${
                activeTab === 'positions'
                  ? 'bg-white text-black'
                  : 'bg-zinc-950 text-zinc-400 hover:text-white border border-zinc-900'
              }`}
            >
              Active Positions ({positions.length})
            </button>
            <button
              onClick={() => setActiveTab('history')}
              className={`px-3.5 py-1.5 text-xs font-mono font-semibold rounded uppercase tracking-wider transition-colors cursor-pointer ${
                activeTab === 'history'
                  ? 'bg-white text-black'
                  : 'bg-zinc-950 text-zinc-400 hover:text-white border border-zinc-900'
              }`}
            >
              Trade Log ({history.length})
            </button>
            <button
              onClick={() => setActiveTab('settings')}
              className={`px-3.5 py-1.5 text-xs font-mono font-semibold rounded uppercase tracking-wider transition-colors cursor-pointer ${
                activeTab === 'settings'
                  ? 'bg-white text-black'
                  : 'bg-zinc-950 text-zinc-400 hover:text-white border border-zinc-900'
              }`}
            >
              Portefeuille & Config
            </button>
          </div>

          <div className="text-[11px] font-mono text-zinc-400 hidden md:flex items-center gap-3">
            <span>Mode: <strong className={config.executionMode === 'wallet' ? 'text-emerald-400' : 'text-zinc-300'}>{config.executionMode === 'wallet' ? 'RÉEL' : 'SIMULATION'}</strong></span>
            <span>TP: <strong className="text-white">{config.takeProfitPercent > 0 ? `+${config.takeProfitPercent}%` : 'Off'}</strong></span>
            <span>SL: <strong className="text-zinc-300">{config.stopLossPercent > 0 ? `-${config.stopLossPercent}%` : 'Off'}</strong></span>
            <span>Trailing: <strong className={config.trailingStopPercent > 0 ? 'text-amber-300' : 'text-zinc-500'}>{config.trailingStopPercent > 0 ? `-${config.trailingStopPercent}%` : 'Off'}</strong></span>
          </div>
        </div>

        {/* Manual CA Scanner component (always visible for rapid testing) */}
        <ManualAnalyzer
          onAnalyze={handleManualAnalyze}
          isAnalyzing={isManualAnalyzing}
        />

        {/* Tab Views */}
        {activeTab === 'stream' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2">
              <TelegramFeed
                calls={calls}
                status={telegramStatus}
                onChannelsUpdated={(updated) => setTelegramStatus(updated)}
                onSelectCall={(call) => setSelectedCall(call)}
                onManualSnipe={handleManualSnipe}
              />
            </div>
            <div>
              <ActivePositions
                positions={positions}
                onSellPosition={handleSellPosition}
                onUpdateTargets={handleUpdatePositionTargets}
              />
            </div>
          </div>
        )}

        {activeTab === 'positions' && (
          <div className="max-w-4xl mx-auto">
            <ActivePositions
              positions={positions}
              onSellPosition={handleSellPosition}
              onUpdateTargets={handleUpdatePositionTargets}
            />
          </div>
        )}

        {activeTab === 'history' && (
          <div className="max-w-4xl mx-auto">
            <TradeHistory history={history} />
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="max-w-3xl mx-auto">
            <SniperSettings
              config={config}
              status={telegramStatus}
              onUpdateConfig={handleUpdateConfig}
              onRequestTelegramCode={handleRequestTelegramCode}
              onVerifyTelegramCode={handleVerifyTelegramCode}
              onImportPrivateKey={handleImportPrivateKey}
              onRefreshWalletBalance={handleRefreshBalance}
              onDisconnectTelegram={handleDisconnectTelegram}
            />
          </div>
        )}
      </main>

      {/* Analysis Detailed Modal */}
      {selectedCall && (
        <AnalysisModal
          call={selectedCall}
          onClose={() => setSelectedCall(null)}
          onManualSnipe={handleManualSnipe}
        />
      )}

      {/* Toast notification banner */}
      {toastMessage && (
        <div className="fixed bottom-5 right-5 z-50 bg-white text-black px-4 py-2.5 rounded shadow-xl font-mono text-xs font-semibold border border-zinc-300">
          {toastMessage}
        </div>
      )}
    </div>
  );
}
