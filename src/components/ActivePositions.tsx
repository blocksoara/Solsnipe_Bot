import React, { useState } from 'react';
import { ActivePosition } from '../types';

interface ActivePositionsProps {
  positions: ActivePosition[];
  onSellPosition: (positionId: string, percent: number) => void;
  onUpdateTargets?: (
    positionId: string,
    targets: { tpPercent?: number; slPercent?: number; trailingStopPercent?: number }
  ) => Promise<void>;
}

export const ActivePositions: React.FC<ActivePositionsProps> = ({
  positions,
  onSellPosition,
  onUpdateTargets,
}) => {
  const [sellingState, setSellingState] = useState<{ id: string; percent: number } | null>(null);
  const [editingPosId, setEditingPosId] = useState<string | null>(null);
  const [editTp, setEditTp] = useState<string>('');
  const [editSl, setEditSl] = useState<string>('');
  const [editTrailing, setEditTrailing] = useState<string>('');
  const [isSavingTargets, setIsSavingTargets] = useState<boolean>(false);

  const handleSellClick = async (positionId: string, percent: number) => {
    setSellingState({ id: positionId, percent });
    try {
      await onSellPosition(positionId, percent);
    } finally {
      setSellingState(null);
    }
  };

  const startEditing = (pos: ActivePosition) => {
    setEditingPosId(pos.id);
    setEditTp(pos.tpPercent.toString());
    setEditSl(pos.slPercent.toString());
    setEditTrailing(pos.trailingStopPercent.toString());
  };

  const cancelEditing = () => {
    setEditingPosId(null);
  };

  const saveEditedTargets = async (positionId: string) => {
    if (!onUpdateTargets) return;
    setIsSavingTargets(true);
    try {
      await onUpdateTargets(positionId, {
        tpPercent: parseFloat(editTp) || 0,
        slPercent: parseFloat(editSl) || 0,
        trailingStopPercent: parseFloat(editTrailing) || 0,
      });
      setEditingPosId(null);
    } finally {
      setIsSavingTargets(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between pb-2 border-b border-zinc-900">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-white tracking-wide font-mono uppercase">
            Active Sniped Positions
          </span>
          <span className="text-xs text-zinc-500 font-mono">
            ({positions.length} open)
          </span>
        </div>
        <span className="text-xs font-mono text-zinc-500">
          Dexscreener Realtime
        </span>
      </div>

      {positions.length === 0 ? (
        <div className="p-8 text-center border border-dashed border-zinc-900 rounded bg-zinc-950/40">
          <p className="text-xs font-mono text-zinc-500 mb-1">
            No active positions open.
          </p>
          <p className="text-[11px] text-zinc-600">
            When a verified call matches all 7 GMGN criteria, SolSnipe automatically executes the trade.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {positions.map((pos, idx) => {
            const isProfit = pos.pnlPercent >= 0;
            const hasTp = pos.tpPercent > 0;
            const hasSl = pos.slPercent > 0;
            const hasTrailing = pos.trailingStopPercent > 0;
            const progressToTp = hasTp
              ? Math.min(100, Math.max(0, (pos.pnlPercent / pos.tpPercent) * 100))
              : 0;
            const isEditing = editingPosId === pos.id;

            return (
              <div
                key={`${pos.id}_${idx}`}
                className="p-4 rounded border border-white/20 bg-zinc-950/90 shadow-sm transition-all"
              >
                {/* Top Row: Symbol, Router badge, PnL readout */}
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-base font-bold font-mono text-white">
                        ${pos.tokenSymbol}
                      </span>
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-900 text-zinc-400 border border-zinc-800 uppercase">
                        {pos.router}
                      </span>
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-900 text-zinc-500">
                        {pos.executionMode === 'simulation' ? 'SIM' : 'LIVE'}
                      </span>
                    </div>
                    <div className="text-[11px] font-mono text-zinc-500 mt-0.5">
                      Invested: {pos.amountSol} SOL
                    </div>
                  </div>

                  {/* PnL Display */}
                  <div className="text-right">
                    <div
                      className={`text-base font-mono font-bold ${
                        isProfit ? 'text-white' : 'text-zinc-400'
                      }`}
                    >
                      {isProfit ? '+' : ''}
                      {pos.pnlPercent.toFixed(2)}%
                    </div>
                    <div className="text-xs font-mono text-zinc-400">
                      {isProfit ? '+' : ''}${pos.pnlUsd.toFixed(2)} USD
                    </div>
                  </div>
                </div>

                {/* Price Matrix */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 my-3 p-2.5 rounded bg-black border border-zinc-900 text-xs font-mono">
                  <div>
                    <div className="text-[10px] text-zinc-500">ENTRY PRICE</div>
                    <div className="text-zinc-300 font-semibold truncate">
                      ${formatPrice(pos.entryPriceUsd)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-zinc-500">LIVE PRICE</div>
                    <div className="text-white font-semibold truncate">
                      ${formatPrice(pos.currentPriceUsd)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-zinc-500">HIGH / PEAK</div>
                    <div className="text-zinc-300 font-semibold truncate">
                      ${formatPrice(pos.peakPriceUsd)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-zinc-500">TRAILING SL</div>
                    <div className="text-zinc-400 font-semibold truncate">
                      {hasTrailing && pos.trailingStopPriceUsd > 0
                        ? `$${formatPrice(pos.trailingStopPriceUsd)}`
                        : 'DÉSACTIVÉ (0%)'}
                    </div>
                  </div>
                </div>

                {/* Targets Indicators (TP, SL, Trailing) */}
                <div className="space-y-1.5 my-2.5 text-xs font-mono">
                  <div className="flex items-center justify-between text-[11px] text-zinc-400 flex-wrap gap-1">
                    <span>
                      SL:{' '}
                      {hasSl ? (
                        <strong className="text-zinc-300">
                          -{pos.slPercent}% (${formatPrice(pos.slPriceUsd)})
                        </strong>
                      ) : (
                        <span className="text-zinc-500">Désactivé (0%)</span>
                      )}
                    </span>
                    <span>
                      TP:{' '}
                      {hasTp ? (
                        <strong className="text-white">
                          +{pos.tpPercent}% (${formatPrice(pos.tpPriceUsd)})
                        </strong>
                      ) : (
                        <span className="text-zinc-500">Désactivé (0%)</span>
                      )}
                    </span>
                  </div>

                  {/* Progress bar towards TP */}
                  {hasTp && (
                    <div className="h-1.5 w-full bg-zinc-900 rounded overflow-hidden">
                      <div
                        className="h-full bg-white transition-all duration-500"
                        style={{ width: `${progressToTp}%` }}
                      />
                    </div>
                  )}

                  <div className="flex items-center justify-between text-[10px] text-zinc-500">
                    <span>
                      Trailing Stop:{' '}
                      {hasTrailing ? (
                        <span className="text-amber-400">
                          -{pos.trailingStopPercent}% depuis le pic
                        </span>
                      ) : (
                        <span className="text-zinc-600">Désactivé (0%)</span>
                      )}
                    </span>
                    <span>
                      Actif depuis {Math.floor((Date.now() - pos.openedAt) / 1000)}s
                    </span>
                  </div>
                </div>

                {/* Inline Targets Editor */}
                {isEditing && (
                  <div className="my-3 p-3 rounded border border-zinc-800 bg-black text-xs font-mono space-y-3">
                    <div className="flex items-center justify-between border-b border-zinc-900 pb-1.5">
                      <span className="font-semibold text-white">
                        AJUSTER LES LIMITES DE CETTE POSITION
                      </span>
                      <span className="text-[10px] text-zinc-500">0% = Désactiver</span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      {/* Edit TP */}
                      <div>
                        <div className="text-[10px] text-zinc-400 mb-1">TP % (0 = Off)</div>
                        <input
                          type="number"
                          step="1"
                          min="0"
                          value={editTp}
                          onChange={(e) => setEditTp(e.target.value)}
                          className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-white text-xs"
                        />
                        <div className="flex gap-1 mt-1">
                          <button
                            type="button"
                            onClick={() => setEditTp('0')}
                            className="px-1 text-[10px] bg-zinc-900 text-zinc-400 rounded hover:text-white"
                          >
                            0%
                          </button>
                          {[25, 50, 100].map((v) => (
                            <button
                              type="button"
                              key={v}
                              onClick={() => setEditTp(v.toString())}
                              className="px-1 text-[10px] bg-zinc-900 text-zinc-400 rounded hover:text-white"
                            >
                              +{v}%
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Edit SL */}
                      <div>
                        <div className="text-[10px] text-zinc-400 mb-1">SL % (0 = Off)</div>
                        <input
                          type="number"
                          step="1"
                          min="0"
                          max="99"
                          value={editSl}
                          onChange={(e) => setEditSl(e.target.value)}
                          className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-white text-xs"
                        />
                        <div className="flex gap-1 mt-1">
                          <button
                            type="button"
                            onClick={() => setEditSl('0')}
                            className="px-1 text-[10px] bg-zinc-900 text-zinc-400 rounded hover:text-white"
                          >
                            0%
                          </button>
                          {[10, 15, 25].map((v) => (
                            <button
                              type="button"
                              key={v}
                              onClick={() => setEditSl(v.toString())}
                              className="px-1 text-[10px] bg-zinc-900 text-zinc-400 rounded hover:text-white"
                            >
                              -{v}%
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Edit Trailing Stop */}
                      <div>
                        <div className="text-[10px] text-zinc-400 mb-1">Trailing Stop % (0 = Off)</div>
                        <input
                          type="number"
                          step="0.5"
                          min="0"
                          max="90"
                          value={editTrailing}
                          onChange={(e) => setEditTrailing(e.target.value)}
                          className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-white text-xs"
                        />
                        <div className="flex gap-1 mt-1">
                          <button
                            type="button"
                            onClick={() => setEditTrailing('0')}
                            className="px-1 text-[10px] bg-amber-950/80 text-amber-300 rounded hover:text-white"
                          >
                            0% (Off)
                          </button>
                          {[5, 10, 15].map((v) => (
                            <button
                              type="button"
                              key={v}
                              onClick={() => setEditTrailing(v.toString())}
                              className="px-1 text-[10px] bg-zinc-900 text-zinc-400 rounded hover:text-white"
                            >
                              {v}%
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center justify-end gap-2 pt-1 border-t border-zinc-900">
                      <button
                        type="button"
                        onClick={cancelEditing}
                        disabled={isSavingTargets}
                        className="px-2.5 py-1 rounded bg-zinc-900 text-zinc-400 hover:text-white text-xs cursor-pointer"
                      >
                        Annuler
                      </button>
                      <button
                        type="button"
                        onClick={() => saveEditedTargets(pos.id)}
                        disabled={isSavingTargets}
                        className="px-3 py-1 rounded bg-white text-black font-semibold text-xs hover:bg-zinc-200 cursor-pointer"
                      >
                        {isSavingTargets ? 'Enregistrement...' : 'Enregistrer'}
                      </button>
                    </div>
                  </div>
                )}

                {/* Quick Exit & Adjust Actions */}
                <div className="flex items-center justify-between gap-2 pt-2 border-t border-zinc-900">
                  <div>
                    {!isEditing && onUpdateTargets && (
                      <button
                        type="button"
                        onClick={() => startEditing(pos)}
                        className="text-[11px] font-mono text-zinc-400 hover:text-white flex items-center gap-1 cursor-pointer"
                      >
                        ⚙ Modifier SL/TP/TS
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      id={`btn-sell-50-${pos.id}`}
                      disabled={sellingState?.id === pos.id}
                      onClick={() => handleSellClick(pos.id, 50)}
                      className="px-3 py-1.5 text-xs font-mono rounded bg-zinc-900 text-zinc-300 hover:text-white border border-zinc-800 hover:border-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 transition-opacity cursor-pointer"
                    >
                      {sellingState?.id === pos.id && sellingState?.percent === 50 ? (
                        <>
                          <span className="w-2.5 h-2.5 border-2 border-zinc-400 border-t-transparent rounded-full animate-spin" />
                          SELLING 50%...
                        </>
                      ) : (
                        'SELL 50%'
                      )}
                    </button>
                    <button
                      id={`btn-sell-100-${pos.id}`}
                      disabled={sellingState?.id === pos.id}
                      onClick={() => handleSellClick(pos.id, 100)}
                      className="px-3.5 py-1.5 text-xs font-mono font-semibold rounded bg-white text-black hover:bg-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 transition-opacity cursor-pointer"
                    >
                      {sellingState?.id === pos.id && sellingState?.percent === 100 ? (
                        <>
                          <span className="w-2.5 h-2.5 border-2 border-black border-t-transparent rounded-full animate-spin" />
                          SELLING 100%...
                        </>
                      ) : (
                        'SELL 100%'
                      )}
                    </button>
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

function formatPrice(p: number): string {
  if (p === 0) return '0.00';
  if (p < 0.00001) return p.toExponential(4);
  if (p < 1) return p.toFixed(6);
  return p.toFixed(2);
}
