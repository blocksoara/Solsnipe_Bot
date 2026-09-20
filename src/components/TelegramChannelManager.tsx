import React, { useState } from 'react';
import {
  Radio,
  Plus,
  Trash2,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  RotateCcw,
  Layers,
  X,
} from 'lucide-react';
import { TelegramStatus } from '../types';

interface TelegramChannelManagerProps {
  status: TelegramStatus | null;
  onChannelsUpdated?: (updatedStatus: TelegramStatus) => void;
  compact?: boolean;
}

const PRESET_CHANNELS = [
  { name: 'pumpdotfunalert', label: 'Pump.fun Alert', desc: 'Alertes whales & migrations pump.fun' },
  { name: 'solana_tracker', label: 'Solana Tracker', desc: 'Nouveaux tokens & tracking volume' },
  { name: 'dexscreener', label: 'DexScreener', desc: 'Alertes tendances et listings DEX' },
  { name: 'solana', label: 'Solana Official', desc: 'Annonces officielles écosystème' },
  { name: 'raydium', label: 'Raydium Protocol', desc: 'Mises à jour et alertes Raydium' },
];

export const TelegramChannelManager: React.FC<TelegramChannelManagerProps> = ({
  status,
  onChannelsUpdated,
  compact = false,
}) => {
  const [channelInput, setChannelInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  const channels: string[] = status?.channels && status.channels.length > 0
    ? status.channels
    : [];

  const handleAddChannels = async (inputToAdd?: string) => {
    const raw = (inputToAdd !== undefined ? inputToAdd : channelInput).trim();
    if (!raw) return;

    // Check username syntax (4-32 alphanumeric or underscores)
    const cleaned = raw
      .replace(/^https?:\/\//i, '')
      .replace(/^(?:www\.)?(?:telegram\.me|t\.me)\//i, '')
      .replace(/^s\//i, '')
      .replace(/^joinchat\//i, '')
      .replace(/^@/, '')
      .replace(/\/.*$/, '')
      .trim();

    if (!/^[a-zA-Z0-9_]{4,32}$/.test(cleaned)) {
      setFeedback({
        type: 'error',
        text: `Identifiant "${cleaned || raw}" invalide. Les identifiants Telegram doivent comporter entre 4 et 32 caractères alphanumériques (a-z, 0-9, _) sans espaces.`,
      });
      return;
    }

    setIsProcessing(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/telegram/add-channel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: raw }),
      });
      const data = await res.json();
      if (data.success) {
        setFeedback({
          type: 'success',
          text: data.message || `${raw} ajouté à la surveillance avec succès !`,
        });
        if (inputToAdd === undefined) setChannelInput('');
        if (data.status && onChannelsUpdated) {
          onChannelsUpdated(data.status);
        }
      } else {
        setFeedback({
          type: 'error',
          text: data.message || "Impossible d'ajouter ce canal (déjà présent ou invalide).",
        });
      }
    } catch (err: any) {
      setFeedback({
        type: 'error',
        text: err.message || "Erreur réseau lors de l'ajout du canal",
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleRemoveChannel = async (channelName: string) => {
    setIsProcessing(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/telegram/remove-channel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: channelName }),
      });
      const data = await res.json();
      if (data.success) {
        setFeedback({
          type: 'info',
          text: `Canal ${channelName} retiré de la surveillance.`,
        });
        if (data.status && onChannelsUpdated) {
          onChannelsUpdated(data.status);
        }
      } else {
        setFeedback({
          type: 'error',
          text: data.message || 'Impossible de retirer ce canal',
        });
      }
    } catch (err: any) {
      setFeedback({
        type: 'error',
        text: err.message || 'Erreur lors de la suppression du canal',
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleClearAll = async () => {
    setIsProcessing(true);
    setFeedback(null);
    setShowClearConfirm(false);
    try {
      const res = await fetch('/api/telegram/remove-channel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clearAll: true }),
      });
      const data = await res.json();
      if (data.success) {
        setFeedback({
          type: 'info',
          text: 'Tous les canaux ont été retirés. Vous pouvez en ajouter de nouveaux ou restaurer le canal par défaut.',
        });
        if (data.status && onChannelsUpdated) {
          onChannelsUpdated(data.status);
        }
      }
    } catch (err: any) {
      setFeedback({
        type: 'error',
        text: err.message || 'Erreur lors de la suppression de tous les canaux',
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleRestoreDefault = async () => {
    await handleAddChannels('pumpdotfunalert');
  };

  return (
    <div className={`rounded-lg border border-zinc-800 bg-zinc-950 font-mono text-xs ${compact ? 'p-3 space-y-3' : 'p-4 sm:p-5 space-y-4'}`}>
      {/* Header section */}
      <div className="flex items-center justify-between flex-wrap gap-2 pb-2.5 border-b border-zinc-900">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded bg-zinc-900 border border-zinc-800 text-emerald-400">
            <Radio className="w-4 h-4 animate-pulse" />
          </div>
          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-white flex items-center gap-2">
              <span>Canaux Telegram Surveillés</span>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-zinc-900 text-emerald-400 border border-zinc-800">
                {channels.length} actif{channels.length > 1 ? 's' : ''}
              </span>
            </div>
            {!compact && (
              <p className="text-[11px] text-zinc-400 mt-0.5">
                Ajoutez ou retirez autant de canaux Telegram que souhaité. Écoute multi-canaux continue en direct.
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {channels.length > 0 ? (
            showClearConfirm ? (
              <div className="flex items-center gap-1.5 bg-red-950/80 border border-red-800 px-2 py-1 rounded text-[10px]">
                <span className="text-red-300">Confirmer ?</span>
                <button
                  type="button"
                  onClick={handleClearAll}
                  disabled={isProcessing}
                  className="px-1.5 py-0.5 rounded bg-red-600 text-white font-bold hover:bg-red-500 cursor-pointer"
                >
                  Oui, Tout Vider
                </button>
                <button
                  type="button"
                  onClick={() => setShowClearConfirm(false)}
                  className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 hover:text-white cursor-pointer"
                >
                  Annuler
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowClearConfirm(true)}
                disabled={isProcessing}
                className="text-[10px] text-zinc-500 hover:text-red-400 flex items-center gap-1 transition-colors cursor-pointer"
                title="Supprimer tous les canaux"
              >
                <Trash2 className="w-3 h-3" />
                <span>Tout vider</span>
              </button>
            )
          ) : (
            <button
              type="button"
              onClick={handleRestoreDefault}
              disabled={isProcessing}
              className="text-[10px] text-emerald-400 hover:text-emerald-300 flex items-center gap-1 cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Restaurer pumpdotfunalert</span>
            </button>
          )}
        </div>
      </div>

      {/* Quick Add Form */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleAddChannels();
        }}
        className="space-y-2"
      >
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              type="text"
              placeholder="Ex: pumpdotfunalert, solanapools, @channel (séparés par virgule pour plusieurs)..."
              value={channelInput}
              onChange={(e) => setChannelInput(e.target.value)}
              disabled={isProcessing}
              className="w-full bg-black border border-zinc-800 rounded px-3 py-2 text-white text-xs font-mono placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500"
            />
            {channelInput && (
              <button
                type="button"
                onClick={() => setChannelInput('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-white"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <button
            type="submit"
            disabled={isProcessing || !channelInput.trim()}
            className="px-4 py-2 rounded bg-emerald-500 hover:bg-emerald-400 text-black font-bold uppercase tracking-wider text-xs transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 shrink-0"
          >
            <Plus className="w-4 h-4 stroke-[3]" />
            <span>{isProcessing ? 'Ajout...' : 'Ajouter'}</span>
          </button>
        </div>

        {/* Preset suggestions */}
        <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
          <span className="text-[10px] text-zinc-500 flex items-center gap-1">
            <Sparkles className="w-3 h-3 text-amber-400" />
            Suggestions rapides :
          </span>
          {PRESET_CHANNELS.map((preset) => {
            const isAlreadyAdded = channels.some((c) =>
              c.toLowerCase().includes(preset.name.toLowerCase())
            );
            return (
              <button
                key={preset.name}
                type="button"
                disabled={isProcessing || isAlreadyAdded}
                onClick={() => handleAddChannels(preset.name)}
                title={isAlreadyAdded ? 'Déjà dans votre liste' : preset.desc}
                className={`px-2 py-0.5 rounded text-[10px] border transition-colors flex items-center gap-1 cursor-pointer ${
                  isAlreadyAdded
                    ? 'bg-zinc-900/60 border-zinc-850 text-zinc-600 cursor-not-allowed'
                    : 'bg-zinc-900 border-zinc-800 text-zinc-300 hover:border-emerald-500/50 hover:text-white'
                }`}
              >
                <Plus className="w-2.5 h-2.5" />
                <span>t.me/{preset.name}</span>
                {isAlreadyAdded && <span className="text-[9px] text-emerald-500">✓</span>}
              </button>
            );
          })}
        </div>
      </form>

      {/* Feedback banner */}
      {feedback && (
        <div
          className={`p-2.5 rounded text-xs flex items-center justify-between gap-2 ${
            feedback.type === 'success'
              ? 'bg-emerald-950/60 border border-emerald-800/60 text-emerald-300'
              : feedback.type === 'error'
              ? 'bg-red-950/60 border border-red-800/60 text-red-300'
              : 'bg-sky-950/60 border border-sky-800/60 text-sky-300'
          }`}
        >
          <div className="flex items-center gap-2">
            {feedback.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            ) : feedback.type === 'error' ? (
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
            ) : (
              <Layers className="w-4 h-4 text-sky-400 shrink-0" />
            )}
            <span>{feedback.text}</span>
          </div>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-zinc-500 hover:text-white text-xs"
          >
            ✕
          </button>
        </div>
      )}

      {/* Active Channels List */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-[11px] text-zinc-400">
          <span>Liste des canaux actifs ({channels.length}) :</span>
          <span className="text-[10px] text-zinc-500">Cliquez sur la croix pour retirer un canal</span>
        </div>

        {channels.length === 0 ? (
          <div className="p-6 text-center border border-dashed border-zinc-800 rounded bg-black/40 space-y-2">
            <p className="text-zinc-400 text-xs font-semibold">Aucun canal Telegram configuré</p>
            <p className="text-zinc-600 text-[11px]">
              Ajoutez un ou plusieurs canaux ci-dessus pour démarrer l'écoute en direct.
            </p>
            <button
              type="button"
              onClick={handleRestoreDefault}
              className="px-3 py-1.5 rounded bg-zinc-850 hover:bg-zinc-800 text-white text-xs inline-flex items-center gap-1.5 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5 text-emerald-400" />
              Ajouter pumpdotfunalert (par défaut)
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {channels.map((ch) => {
              const clean = ch.replace('https://t.me/', '').replace('t.me/', '').replace('@', '');
              const slug = `t.me/${clean}`;
              const count = status?.channelCounts?.[slug] ?? 0;
              const error = status?.channelErrors?.[slug];

              return (
                <div
                  key={ch}
                  className={`flex items-center justify-between p-2.5 rounded bg-black border transition-colors group ${
                    error ? 'border-amber-900/60 bg-amber-950/10' : 'border-zinc-850 hover:border-zinc-750'
                  }`}
                >
                  <div className="flex items-center gap-2 truncate min-w-0">
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${
                        error ? 'bg-amber-400' : 'bg-emerald-400 animate-pulse'
                      }`}
                    />
                    <div className="truncate min-w-0">
                      <div className="flex items-center gap-1 text-xs font-semibold text-white truncate">
                        <span className="truncate">t.me/{clean}</span>
                        <a
                          href={`https://t.me/${clean}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Ouvrir dans Telegram"
                          className="text-zinc-600 hover:text-sky-400 shrink-0"
                        >
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                      {error ? (
                        <div className="text-[10px] text-amber-400/90 font-mono truncate" title={error}>
                          ⚠️ {error}
                        </div>
                      ) : (
                        <div className="text-[10px] text-zinc-500 font-mono">
                          {count} alerte{count > 1 ? 's' : ''} reçue{count > 1 ? 's' : ''}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0 ml-2">
                    <button
                      type="button"
                      onClick={() => handleRemoveChannel(clean)}
                      disabled={isProcessing}
                      title={`Retirer t.me/${clean} de la surveillance`}
                      className="p-1.5 rounded text-zinc-500 hover:text-red-400 hover:bg-zinc-900 border border-transparent hover:border-red-900/40 transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
