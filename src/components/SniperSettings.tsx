import React, { useState, useEffect } from 'react';
import {
  Wallet,
  Key,
  Phone,
  Send,
  CheckCircle2,
  AlertCircle,
  Eye,
  EyeOff,
  Copy,
  Check,
  RefreshCw,
  ExternalLink,
  ShieldCheck,
  Lock,
  Zap,
  Sliders,
  Radio,
  Trash2,
  Plus,
} from 'lucide-react';
import { SniperConfig, TelegramStatus } from '../types';
import { TelegramChannelManager } from './TelegramChannelManager';

interface SniperSettingsProps {
  config: SniperConfig;
  status: TelegramStatus | null;
  onUpdateConfig: (newConfig: Partial<SniperConfig>) => void;
  onRequestTelegramCode: (phone?: string) => Promise<{ success: boolean; message: string; requiresPassword?: boolean }>;
  onVerifyTelegramCode: (code: string, password?: string) => Promise<{ success: boolean; message: string; requiresPassword?: boolean }>;
  onImportPrivateKey: (pk: string) => Promise<{ success: boolean; message: string; publicKey?: string; balanceSol?: number }>;
  onRefreshWalletBalance?: () => Promise<void>;
  onDisconnectTelegram?: () => Promise<{ success: boolean; message: string }>;
}

export const SniperSettings: React.FC<SniperSettingsProps> = ({
  config,
  status,
  onUpdateConfig,
  onRequestTelegramCode,
  onVerifyTelegramCode,
  onImportPrivateKey,
  onRefreshWalletBalance,
  onDisconnectTelegram,
}) => {
  // Strategy settings
  const [amount, setAmount] = useState(config.tradingAmountSol.toString());
  const [tp, setTp] = useState(config.takeProfitPercent.toString());
  const [sl, setSl] = useState(config.stopLossPercent.toString());
  const [trailing, setTrailing] = useState(config.trailingStopPercent.toString());
  const [slippage, setSlippage] = useState(config.slippagePercent.toString());
  const [priorityFee, setPriorityFee] = useState((config.priorityFeeSol || 0.005).toString());
  const [jitoTip, setJitoTip] = useState((config.jitoTipSol || 0.005).toString());
  const [router, setRouter] = useState(config.router);
  const [mode, setMode] = useState(config.executionMode);
  const [saveSuccessMsg, setSaveSuccessMsg] = useState<string | null>(null);

  // Wallet Management
  const [privateKeyInput, setPrivateKeyInput] = useState('');
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const [importStatus, setImportStatus] = useState<{ success: boolean; message: string } | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isRefreshingBalance, setIsRefreshingBalance] = useState(false);
  const [copiedAddress, setCopiedAddress] = useState(false);
  const [exportedKey, setExportedKey] = useState<string | null>(null);
  const [isExportingKey, setIsExportingKey] = useState(false);
  const [showExportedKey, setShowExportedKey] = useState(false);
  const [copiedExportedKey, setCopiedExportedKey] = useState(false);

  // Telegram Authentication
  const [phoneInput, setPhoneInput] = useState(status?.phone || '+242068658897');
  const [tgCodeInput, setTgCodeInput] = useState('');
  const [tgPasswordInput, setTgPasswordInput] = useState('');
  const [show2FaField, setShow2FaField] = useState(false);
  const [isRequestingCode, setIsRequestingCode] = useState(false);
  const [isVerifyingCode, setIsVerifyingCode] = useState(false);
  const [isDisconnectingTg, setIsDisconnectingTg] = useState(false);
  const [tgFeedback, setTgFeedback] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [newChannelInput, setNewChannelInput] = useState('');
  const [isManagingChannel, setIsManagingChannel] = useState(false);

  // Sync state when config updates
  useEffect(() => {
    setAmount(config.tradingAmountSol.toString());
    setTp(config.takeProfitPercent.toString());
    setSl(config.stopLossPercent.toString());
    setTrailing(config.trailingStopPercent.toString());
    setSlippage(config.slippagePercent.toString());
    setPriorityFee((config.priorityFeeSol || 0.005).toString());
    setJitoTip((config.jitoTipSol || 0.005).toString());
    setRouter(config.router);
    setMode(config.executionMode);
  }, [config]);

  // Sync phone input when status updates
  useEffect(() => {
    if (status?.phone && !phoneInput) {
      setPhoneInput(status.phone);
    }
  }, [status?.phone]);

  const parseNumber = (val: string, fallback: number, allowZero: boolean = true): number => {
    const trimmed = (val ?? '').trim();
    if (trimmed === '') return fallback;
    const num = parseFloat(trimmed);
    if (isNaN(num)) return fallback;
    if (allowZero && num === 0) return 0;
    if (num < 0) return 0;
    return num;
  };

  const handleSaveStrategy = (e: React.FormEvent) => {
    e.preventDefault();
    const finalAmount = parseNumber(amount, 0.1, false);
    const finalTp = parseNumber(tp, 50, true);
    const finalSl = parseNumber(sl, 15, true);
    const finalTrailing = parseNumber(trailing, 0, true);
    const finalSlippage = parseNumber(slippage, 5, false);
    const finalPriorityFee = parseNumber(priorityFee, 0.005, false);
    const finalJitoTip = parseNumber(jitoTip, 0.005, false);

    onUpdateConfig({
      tradingAmountSol: finalAmount,
      takeProfitPercent: finalTp,
      stopLossPercent: finalSl,
      trailingStopPercent: finalTrailing,
      slippagePercent: finalSlippage,
      priorityFeeSol: finalPriorityFee,
      jitoTipSol: finalJitoTip,
      router,
      executionMode: mode,
    });

    setSaveSuccessMsg(
      `✓ Configuration enregistrée et sauvegardée (Mode: ${mode === 'wallet' ? 'RÉEL' : 'SIMULATION'}, Achat: ${finalAmount} SOL, TP: ${finalTp > 0 ? `+${finalTp}%` : 'Off'}, SL: ${finalSl > 0 ? `-${finalSl}%` : 'Off'}, Trailing: ${finalTrailing > 0 ? `-${finalTrailing}%` : 'Off'})`
    );
    setTimeout(() => setSaveSuccessMsg(null), 5000);
  };

  const applyPreset = (presetTp: number, presetSl: number, presetTrailing: number) => {
    setTp(presetTp.toString());
    setSl(presetSl.toString());
    setTrailing(presetTrailing.toString());
  };

  // --- Wallet Actions ---
  const handleCopyAddress = () => {
    if (!config.walletPublicKey) return;
    navigator.clipboard.writeText(config.walletPublicKey);
    setCopiedAddress(true);
    setTimeout(() => setCopiedAddress(false), 2000);
  };

  const handlePastePrivateKey = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setPrivateKeyInput(text.trim());
      }
    } catch {
      // Clipboard permissions fallback
    }
  };

  const handleImportKey = async () => {
    const key = privateKeyInput.trim();
    if (!key) {
      setImportStatus({
        success: false,
        message: 'Veuillez coller ou saisir une clé privée Solana valide',
      });
      return;
    }

    setIsImporting(true);
    setImportStatus(null);
    try {
      const res = await onImportPrivateKey(key);
      setImportStatus({
        success: res.success,
        message: res.message,
      });
      if (res.success) {
        setPrivateKeyInput('');
        setShowPrivateKey(false);
      }
    } catch (err: any) {
      setImportStatus({
        success: false,
        message: err.message || "Erreur lors de l'import de la clé privée",
      });
    } finally {
      setIsImporting(false);
    }
  };

  const handleRefreshBalanceClick = async () => {
    if (!onRefreshWalletBalance) return;
    setIsRefreshingBalance(true);
    try {
      await onRefreshWalletBalance();
    } finally {
      setIsRefreshingBalance(false);
    }
  };

  const handleToggleExportKey = async () => {
    if (exportedKey) {
      setShowExportedKey(!showExportedKey);
      return;
    }
    setIsExportingKey(true);
    try {
      const res = await fetch('/api/wallet/export');
      const data = await res.json();
      if (data.success && data.privateKey) {
        setExportedKey(data.privateKey);
        setShowExportedKey(true);
      }
    } catch (err) {
      console.error('Erreur exportation clé privée:', err);
    } finally {
      setIsExportingKey(false);
    }
  };

  const handleCopyExportedKey = () => {
    if (!exportedKey) return;
    navigator.clipboard.writeText(exportedKey);
    setCopiedExportedKey(true);
    setTimeout(() => setCopiedExportedKey(false), 2000);
  };

  // --- Telegram Actions ---
  const handleRequestTgCode = async () => {
    const phone = phoneInput.trim();
    if (!phone || phone.length < 6) {
      setTgFeedback({
        type: 'error',
        text: 'Veuillez entrer un numéro de téléphone international complet (ex: +242068658897)',
      });
      return;
    }

    setIsRequestingCode(true);
    setTgFeedback(null);
    try {
      const res = await onRequestTelegramCode(phone);
      if (res.success) {
        setTgFeedback({
          type: 'success',
          text: res.message || `Code de vérification envoyé à ${phone}`,
        });
      } else {
        setTgFeedback({
          type: 'error',
          text: res.message || "Échec de l'envoi du code de vérification",
        });
      }
    } catch (err: any) {
      setTgFeedback({
        type: 'error',
        text: err.message || 'Erreur réseau lors de la demande de code',
      });
    } finally {
      setIsRequestingCode(false);
    }
  };

  const handleVerifyTgCode = async () => {
    const code = tgCodeInput.trim();
    if (!code) {
      setTgFeedback({
        type: 'error',
        text: 'Veuillez saisir le code reçu sur Telegram ou par SMS',
      });
      return;
    }

    setIsVerifyingCode(true);
    setTgFeedback(null);
    try {
      const res = await onVerifyTelegramCode(code, tgPasswordInput || undefined);
      if (res.success) {
        setTgFeedback({
          type: 'success',
          text: res.message || 'Compte Telegram authentifié avec succès !',
        });
        setTgCodeInput('');
        setTgPasswordInput('');
      } else {
        if (res.requiresPassword) {
          setShow2FaField(true);
        }
        setTgFeedback({
          type: 'error',
          text: res.message || 'Code de vérification invalide ou expiré',
        });
      }
    } catch (err: any) {
      setTgFeedback({
        type: 'error',
        text: err.message || 'Erreur lors de la vérification du code',
      });
    } finally {
      setIsVerifyingCode(false);
    }
  };

  const handleDisconnectTg = async () => {
    if (!onDisconnectTelegram) return;
    setIsDisconnectingTg(true);
    try {
      const res = await onDisconnectTelegram();
      setTgFeedback({
        type: 'info',
        text: res.message || 'Compte Telegram déconnecté',
      });
    } finally {
      setIsDisconnectingTg(false);
    }
  };

  const handleRemoveChannel = async (channel: string) => {
    setIsManagingChannel(true);
    try {
      const res = await fetch('/api/telegram/remove-channel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel }),
      });
      const data = await res.json();
      if (data.success) {
        setTgFeedback({
          type: 'success',
          text: `Canal ${channel} retiré de la liste de surveillance.`,
        });
      } else {
        setTgFeedback({
          type: 'error',
          text: data.message || 'Impossible de retirer le canal',
        });
      }
    } catch (err: any) {
      setTgFeedback({
        type: 'error',
        text: err.message || 'Erreur lors de la suppression du canal',
      });
    } finally {
      setIsManagingChannel(false);
    }
  };

  const handleAddChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newChannelInput.trim()) return;
    setIsManagingChannel(true);
    try {
      const res = await fetch('/api/telegram/add-channel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: newChannelInput.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        setTgFeedback({
          type: 'success',
          text: `Canal ${newChannelInput.trim()} ajouté avec succès !`,
        });
        setNewChannelInput('');
      } else {
        setTgFeedback({
          type: 'error',
          text: data.message || 'Erreur lors de l\'ajout du canal',
        });
      }
    } catch (err: any) {
      setTgFeedback({
        type: 'error',
        text: err.message || 'Erreur réseau lors de l\'ajout du canal',
      });
    } finally {
      setIsManagingChannel(false);
    }
  };

  const isBalanceLow =
    config.executionMode === 'wallet' &&
    (config.walletBalanceSol ?? 0) < (parseFloat(amount) || 0.1);

  return (
    <div className="space-y-6">
      {/* SECTION 1: PORTEFEUILLE SOLANA (IMPORT CLÉ & MODE RÉEL) */}
      <div className="p-4 sm:p-5 rounded-lg border border-zinc-800 bg-zinc-950 text-xs font-mono space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2 pb-3 border-b border-zinc-900">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded bg-zinc-900 text-emerald-400 border border-zinc-800">
              <Wallet className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                1. Portefeuille Solana & Mode Réel
              </h2>
              <p className="text-[11px] text-zinc-400 mt-0.5">
                Importez votre clé privée pour exécuter les snipes on-chain via Jupiter V6
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span
              className={`px-2.5 py-1 rounded text-[11px] font-bold uppercase tracking-wider border ${
                config.executionMode === 'wallet'
                  ? 'bg-emerald-950/80 border-emerald-500/50 text-emerald-300'
                  : 'bg-zinc-900 border-zinc-800 text-zinc-400'
              }`}
            >
              {config.executionMode === 'wallet' ? '● Mode Réel (Live Wallet)' : '○ Mode Simulation'}
            </span>
          </div>
        </div>

        {/* Mode Switcher */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => {
              setMode('simulation');
              onUpdateConfig({ executionMode: 'simulation' });
            }}
            className={`p-3 rounded border text-left transition-colors cursor-pointer ${
              config.executionMode === 'simulation'
                ? 'bg-white text-black border-white font-semibold'
                : 'bg-zinc-900/60 border-zinc-850 text-zinc-400 hover:text-white hover:border-zinc-700'
            }`}
          >
            <div className="text-xs font-bold uppercase flex items-center gap-1.5">
              <Radio className="w-3.5 h-3.5" />
              Mode Simulation (Paper Trading)
            </div>
            <p className="text-[10px] mt-1 opacity-80">
              Zéro risque : teste les signaux et les triggers (TP/SL) avec un solde virtuel sans dépenser de SOL réels.
            </p>
          </button>

          <button
            type="button"
            onClick={() => {
              setMode('wallet');
              onUpdateConfig({ executionMode: 'wallet' });
            }}
            className={`p-3 rounded border text-left transition-colors cursor-pointer ${
              config.executionMode === 'wallet'
                ? 'bg-emerald-500 text-black border-emerald-400 font-semibold'
                : 'bg-zinc-900/60 border-zinc-850 text-zinc-400 hover:text-white hover:border-zinc-700'
            }`}
          >
            <div className="text-xs font-bold uppercase flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5" />
              Mode Réel (Live Wallet On-Chain)
            </div>
            <p className="text-[10px] mt-1 opacity-80">
              Ordres réels exécutés sur Solana Mainnet via Jupiter V6 et signés par votre clé privée.
            </p>
          </button>
        </div>

        {/* Current Active Wallet & Balance Card */}
        <div className="p-3.5 rounded bg-black border border-zinc-850 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <span className="text-zinc-400 text-[11px] font-semibold uppercase flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              Adresse Publique Active :
            </span>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-zinc-900 border border-zinc-800">
                <span className="text-[10px] text-zinc-400">Solde :</span>
                <span className="text-emerald-400 font-bold text-xs">
                  {(config.walletBalanceSol ?? 0).toFixed(4)} SOL
                </span>
                <button
                  type="button"
                  onClick={handleRefreshBalanceClick}
                  disabled={isRefreshingBalance}
                  title="Actualiser le solde on-chain"
                  className="ml-1 text-zinc-400 hover:text-white transition-colors cursor-pointer disabled:opacity-50"
                >
                  <RefreshCw className={`w-3 h-3 ${isRefreshingBalance ? 'animate-spin' : ''}`} />
                </button>
              </div>

              <span
                className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                  config.hasPrivateKey
                    ? 'bg-emerald-950 text-emerald-400 border border-emerald-800/50'
                    : 'bg-zinc-900 text-zinc-400 border border-zinc-800'
                }`}
              >
                {config.hasPrivateKey ? 'Clé Importée & Prête' : 'Clé Temporaire'}
              </span>
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 p-2 rounded bg-zinc-950 border border-zinc-900">
            <code className="text-white text-xs truncate select-all">
              {config.walletPublicKey || 'Aucun portefeuille Solana configuré'}
            </code>
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={handleCopyAddress}
                className="px-2.5 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-zinc-800 transition-colors flex items-center gap-1 cursor-pointer text-[11px]"
              >
                {copiedAddress ? (
                  <>
                    <Check className="w-3 h-3 text-emerald-400" />
                    <span>Copié !</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3" />
                    <span>Copier</span>
                  </>
                )}
              </button>

              {config.walletPublicKey && (
                <a
                  href={`https://solscan.io/account/${config.walletPublicKey}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-2.5 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white border border-zinc-800 transition-colors flex items-center gap-1 text-[11px]"
                >
                  <ExternalLink className="w-3 h-3" />
                  <span>Solscan</span>
                </a>
              )}

              {config.hasPrivateKey && (
                <button
                  type="button"
                  onClick={handleToggleExportKey}
                  disabled={isExportingKey}
                  className="px-2.5 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-amber-400 border border-zinc-800 transition-colors flex items-center gap-1 text-[11px] cursor-pointer"
                  title="Afficher ou masquer la clé privée de ce portefeuille"
                >
                  {showExportedKey ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                  <span>{showExportedKey ? 'Masquer clé' : 'Voir clé'}</span>
                </button>
              )}
            </div>
          </div>

          {showExportedKey && exportedKey && (
            <div className="p-3 rounded bg-amber-950/30 border border-amber-900/40 text-[11px] space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-bold text-amber-400 flex items-center gap-1.5">
                  <Key className="w-3.5 h-3.5" />
                  Clé Privée Solana (Base58 / Phantom) :
                </span>
                <button
                  type="button"
                  onClick={handleCopyExportedKey}
                  className="px-2 py-0.5 rounded bg-amber-900/50 hover:bg-amber-800 text-amber-200 border border-amber-700/50 transition-colors flex items-center gap-1 cursor-pointer text-[10px]"
                >
                  {copiedExportedKey ? (
                    <>
                      <Check className="w-3 h-3 text-emerald-400" />
                      <span>Copiée !</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" />
                      <span>Copier la clé</span>
                    </>
                  )}
                </button>
              </div>
              <code className="block p-2 rounded bg-black border border-zinc-900 font-mono text-amber-200 text-xs break-all select-all">
                {exportedKey}
              </code>
              <p className="text-[10px] text-zinc-400">
                ⚠️ <strong>Secret critique :</strong> Vous pouvez importer cette clé dans <em>Phantom</em> ou <em>Solflare</em> (Ajouter / Connecter un portefeuille &rarr; Importer une clé privée). Ne la partagez jamais.
              </p>
            </div>
          )}

          {isBalanceLow && (
            <div className="p-2.5 rounded bg-amber-950/40 border border-amber-800/40 text-amber-300 text-[11px] flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
              <span>
                Attention : Votre solde ({(config.walletBalanceSol ?? 0).toFixed(4)} SOL) est inférieur au montant d'achat configuré ({amount} SOL). Veuillez transférer des SOL à l'adresse ci-dessus pour exécuter vos transactions.
              </span>
            </div>
          )}
        </div>

        {/* Private Key Import Input Form */}
        <div className="p-3.5 rounded bg-zinc-900/50 border border-zinc-850 space-y-2.5">
          <div className="flex items-center justify-between">
            <label className="text-zinc-300 font-semibold flex items-center gap-1.5">
              <Key className="w-3.5 h-3.5 text-zinc-400" />
              Importer une Clé Privée Solana :
            </label>
            <button
              type="button"
              onClick={handlePastePrivateKey}
              className="text-[11px] text-zinc-400 hover:text-white underline cursor-pointer flex items-center gap-1"
            >
              Coller depuis le presse-papier
            </button>
          </div>

          <div className="relative">
            <input
              type={showPrivateKey ? 'text' : 'password'}
              placeholder="Collez ici votre clé privée Base58 (ex: Phantom/Solflare) ou tableau JSON [12,34,...]"
              value={privateKeyInput}
              onChange={(e) => setPrivateKeyInput(e.target.value)}
              className="w-full bg-black border border-zinc-800 rounded px-3 py-2 pr-10 text-white text-xs font-mono placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
            />
            <button
              type="button"
              onClick={() => setShowPrivateKey(!showPrivateKey)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 cursor-pointer"
              title={showPrivateKey ? 'Masquer' : 'Afficher'}
            >
              {showPrivateKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>

          <div className="flex items-center justify-between gap-2 flex-wrap">
            <button
              type="button"
              onClick={handleImportKey}
              disabled={isImporting || !privateKeyInput.trim()}
              className="px-4 py-2 rounded bg-white text-black font-bold uppercase tracking-wider hover:bg-zinc-200 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              <Key className="w-3.5 h-3.5" />
              {isImporting ? 'Importation en cours...' : 'Valider & Importer la Clé'}
            </button>

            <span className="text-[10px] text-zinc-500">
              Compatible Phantom, Solflare, Backpack & id.json
            </span>
          </div>

          {importStatus && (
            <div
              className={`p-2.5 rounded text-xs flex items-center gap-2 ${
                importStatus.success
                  ? 'bg-emerald-950/60 border border-emerald-800/50 text-emerald-300'
                  : 'bg-red-950/60 border border-red-800/50 text-red-300'
              }`}
            >
              {importStatus.success ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              ) : (
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
              )}
              <span>{importStatus.message}</span>
            </div>
          )}

          <div className="p-2.5 rounded bg-black/50 border border-zinc-900 text-[10px] text-zinc-400 leading-relaxed">
            <strong className="text-zinc-300">Comment exporter votre clé :</strong> Dans Phantom ou Solflare, allez dans{' '}
            <em>Paramètres &rarr; Sécurité & Confidentialité &rarr; Exporter la clé privée</em>. Votre clé est conservée uniquement en mémoire de votre session pour autoriser les swaps Jupiter.
          </div>
        </div>
      </div>

      {/* SECTION 2: CONNEXION COMPTE TELEGRAM (NUMÉRO & CODE) */}
      <div className="p-4 sm:p-5 rounded-lg border border-zinc-800 bg-zinc-950 text-xs font-mono space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2 pb-3 border-b border-zinc-900">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded bg-zinc-900 text-sky-400 border border-zinc-800">
              <Phone className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                2. Connexion Téléphone & Code Telegram (MTProto)
              </h2>
              <p className="text-[11px] text-zinc-400 mt-0.5">
                Connectez votre compte personnel Telegram pour écouter les canaux en direct
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span
              className={`px-2.5 py-1 rounded text-[11px] font-bold uppercase tracking-wider border ${
                status?.isAuthenticated
                  ? 'bg-sky-950/80 border-sky-500/50 text-sky-300'
                  : 'bg-zinc-900 border-zinc-800 text-zinc-400'
              }`}
            >
              {status?.isAuthenticated ? '● Authentifié MTProto' : '○ Non Connecté'}
            </span>
          </div>
        </div>

        {/* Monitored Channels Manager */}
        <TelegramChannelManager status={status} />

        {/* Telegram Login Form */}
        <div className="p-3.5 rounded bg-zinc-900/50 border border-zinc-850 space-y-3">
          {status?.isAuthenticated ? (
            <div className="space-y-3">
              <div className="p-3 rounded bg-sky-950/40 border border-sky-800/40 text-sky-200 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-sky-400 shrink-0" />
                  <div>
                    <div className="font-bold">Compte Telegram connecté avec succès !</div>
                    <div className="text-[10px] text-sky-300">
                      Utilisateur : @{status.userName || status.phone || phoneInput}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleDisconnectTg}
                  disabled={isDisconnectingTg}
                  className="px-3 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-zinc-700 text-xs cursor-pointer"
                >
                  {isDisconnectingTg ? 'Déconnexion...' : 'Déconnecter'}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Step 1: Phone Number */}
              <div className="space-y-1.5">
                <label className="text-zinc-300 font-semibold flex items-center justify-between">
                  <span>Étape 1 : Numéro de téléphone international (avec indicatif)</span>
                  <span className="text-[10px] text-zinc-500">Ex: +242068658897 ou +336...</span>
                </label>
                <div className="flex gap-2">
                  <input
                    type="tel"
                    placeholder="+242068658897"
                    value={phoneInput}
                    onChange={(e) => setPhoneInput(e.target.value)}
                    className="flex-1 bg-black border border-zinc-800 rounded px-3 py-2 text-white text-xs font-mono focus:outline-none focus:border-zinc-600"
                  />
                  <button
                    type="button"
                    onClick={handleRequestTgCode}
                    disabled={isRequestingCode || !phoneInput.trim()}
                    className="px-3.5 py-2 rounded bg-sky-600 hover:bg-sky-500 text-white font-bold uppercase tracking-wider transition-colors cursor-pointer disabled:opacity-50 flex items-center gap-1.5 shrink-0"
                  >
                    <Send className="w-3.5 h-3.5" />
                    {isRequestingCode ? 'Envoi en cours...' : 'Envoyer le Code'}
                  </button>
                </div>
              </div>

              {/* Step 2: Verification Code & 2FA */}
              <div className="p-3 rounded bg-black border border-zinc-850 space-y-2.5">
                <label className="text-zinc-300 font-semibold flex items-center justify-between">
                  <span>Étape 2 : Code de vérification Telegram (reçu par message Telegram ou SMS)</span>
                  <span className="text-[10px] text-zinc-500">5 chiffres</span>
                </label>

                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="Ex: 58291"
                    value={tgCodeInput}
                    onChange={(e) => setTgCodeInput(e.target.value)}
                    className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-white text-xs font-mono tracking-widest focus:outline-none focus:border-sky-500"
                  />
                  <button
                    type="button"
                    onClick={handleVerifyTgCode}
                    disabled={isVerifyingCode || !tgCodeInput.trim()}
                    className="px-4 py-2 rounded bg-white text-black font-bold uppercase tracking-wider hover:bg-zinc-200 transition-colors cursor-pointer disabled:opacity-50 shrink-0 flex items-center gap-1.5"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    {isVerifyingCode ? 'Validation...' : 'Valider le Code'}
                  </button>
                </div>

                {/* 2FA Toggle / Password Field */}
                <div>
                  {!show2FaField ? (
                    <button
                      type="button"
                      onClick={() => setShow2FaField(true)}
                      className="text-[10px] text-zinc-500 hover:text-zinc-300 underline cursor-pointer flex items-center gap-1"
                    >
                      <Lock className="w-3 h-3" /> Mon compte utilise un mot de passe 2FA (Cloud Password)
                    </button>
                  ) : (
                    <div className="space-y-1 pt-1.5 border-t border-zinc-900">
                      <label className="text-[11px] text-zinc-400 flex items-center gap-1">
                        <Lock className="w-3 h-3 text-amber-400" />
                        Mot de passe Telegram 2FA (si activé) :
                      </label>
                      <input
                        type="password"
                        placeholder="Mot de passe cloud 2FA"
                        value={tgPasswordInput}
                        onChange={(e) => setTgPasswordInput(e.target.value)}
                        className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-1.5 text-white text-xs font-mono focus:outline-none focus:border-zinc-600"
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* Feedback Message */}
              {tgFeedback && (
                <div
                  className={`p-2.5 rounded text-xs flex items-center gap-2 ${
                    tgFeedback.type === 'success'
                      ? 'bg-emerald-950/60 border border-emerald-800/50 text-emerald-300'
                      : tgFeedback.type === 'error'
                      ? 'bg-red-950/60 border border-red-800/50 text-red-300'
                      : 'bg-zinc-900 border border-zinc-800 text-zinc-300'
                  }`}
                >
                  {tgFeedback.type === 'success' ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  ) : (
                    <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                  )}
                  <span>{tgFeedback.text}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* SECTION 3: PARAMÈTRES DE STRATÉGIE & RISQUE */}
      <div className="p-4 sm:p-5 rounded-lg border border-zinc-800 bg-zinc-950 text-xs font-mono space-y-4">
        <div className="flex items-center justify-between pb-3 border-b border-zinc-900">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded bg-zinc-900 text-amber-400 border border-zinc-800">
              <Sliders className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white uppercase tracking-wider">
                3. Paramètres de Trading & Risk Management
              </h2>
              <p className="text-[11px] text-zinc-400 mt-0.5">
                Définissez la taille des ordres, Take Profit, Stop Loss et Trailing Stop
              </p>
            </div>
          </div>
        </div>

        {/* Global Strategy Presets Bar */}
        <div className="p-3 rounded border border-zinc-850 bg-black text-xs space-y-2">
          <div className="flex items-center justify-between text-zinc-400">
            <span className="font-semibold text-zinc-300">PRESETS RAPIDES EN 1 CLIC :</span>
            <span className="text-[10px] text-zinc-500">Applique instantanément les ratios</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
            <button
              type="button"
              onClick={() => applyPreset(25, 10, 5)}
              className="p-2 rounded bg-zinc-900 border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-850 text-left transition-colors cursor-pointer"
            >
              <div className="font-bold text-white text-xs">⚡ Scalp Court</div>
              <div className="text-[10px] text-zinc-400 mt-0.5">TP +25% | SL -10% | TS -5%</div>
            </button>
            <button
              type="button"
              onClick={() => applyPreset(50, 15, 10)}
              className="p-2 rounded bg-zinc-900 border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-850 text-left transition-colors cursor-pointer"
            >
              <div className="font-bold text-white text-xs">⚖️ Équilibré</div>
              <div className="text-[10px] text-zinc-400 mt-0.5">TP +50% | SL -15% | TS -10%</div>
            </button>
            <button
              type="button"
              onClick={() => applyPreset(150, 20, 15)}
              className="p-2 rounded bg-zinc-900 border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-850 text-left transition-colors cursor-pointer"
            >
              <div className="font-bold text-white text-xs">🏃 Runner / Tendance</div>
              <div className="text-[10px] text-zinc-400 mt-0.5">TP +150% | SL -20% | TS -15%</div>
            </button>
            <button
              type="button"
              onClick={() => applyPreset(300, 25, 0)}
              className="p-2 rounded bg-zinc-900 border border-amber-900/40 hover:border-amber-700 hover:bg-zinc-850 text-left transition-colors cursor-pointer"
            >
              <div className="font-bold text-amber-400 text-xs">🌕 Moonbag (TS 0%)</div>
              <div className="text-[10px] text-zinc-400 mt-0.5">TP +300% | SL -25% | TS: Off</div>
            </button>
          </div>
        </div>

        {saveSuccessMsg && (
          <div className="p-3 rounded border border-emerald-500/40 bg-emerald-950/40 text-emerald-300 text-xs flex items-center justify-between">
            <span>{saveSuccessMsg}</span>
            <button
              type="button"
              onClick={() => setSaveSuccessMsg(null)}
              className="text-emerald-400 hover:text-white text-xs ml-2 cursor-pointer"
            >
              ✕
            </button>
          </div>
        )}

        <form onSubmit={handleSaveStrategy} className="space-y-4">
          {/* Amount & Slippage */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="p-3 rounded border border-zinc-850 bg-black">
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-zinc-400 font-semibold">MONTANT PAR SNIPE (SOL)</label>
                <span className="text-[10px] text-zinc-500">Montant d'achat initial</span>
              </div>
              <input
                type="number"
                step="0.01"
                min="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-white font-bold text-sm focus:outline-none focus:border-white"
              />
            </div>

            <div className="p-3 rounded border border-zinc-850 bg-black">
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-zinc-400 font-semibold">SLIPPAGE MAXIMUM (%)</label>
                <span className="text-[10px] text-zinc-500">Tolérance de prix</span>
              </div>
              <input
                type="number"
                step="0.5"
                min="0.5"
                max="50"
                value={slippage}
                onChange={(e) => setSlippage(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-white font-bold text-sm focus:outline-none focus:border-white"
              />
            </div>
          </div>

          {/* TP / SL / Trailing Stop */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="p-3 rounded border border-zinc-850 bg-black">
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-emerald-400 font-semibold">TAKE PROFIT (%)</label>
                <span className="text-[10px] text-zinc-500">0 = Off</span>
              </div>
              <input
                type="number"
                step="1"
                min="0"
                value={tp}
                onChange={(e) => setTp(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-white font-bold text-sm focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div className="p-3 rounded border border-zinc-850 bg-black">
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-red-400 font-semibold">STOP LOSS (%)</label>
                <span className="text-[10px] text-zinc-500">0 = Off</span>
              </div>
              <input
                type="number"
                step="1"
                min="0"
                value={sl}
                onChange={(e) => setSl(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-white font-bold text-sm focus:outline-none focus:border-red-500"
              />
            </div>

            <div className="p-3 rounded border border-zinc-850 bg-black">
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-amber-400 font-semibold">TRAILING STOP (%)</label>
                <span className="text-[10px] text-zinc-500">0 = Désactivé</span>
              </div>
              <input
                type="number"
                step="1"
                min="0"
                value={trailing}
                onChange={(e) => setTrailing(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-white font-bold text-sm focus:outline-none focus:border-amber-500"
              />
            </div>
          </div>

          {/* Router Selection */}
          <div className="p-3 rounded border border-zinc-850 bg-black">
            <div className="flex items-center justify-between mb-2">
              <label className="text-zinc-400 font-semibold">ROUTEUR DE SWAP</label>
              <span className="text-[10px] text-zinc-500">Routage de liquidité</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {(['jupiter', 'jito', 'gmgn'] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRouter(r)}
                  className={`py-2 px-2 text-center rounded border uppercase transition-colors cursor-pointer text-xs ${
                    router === r
                      ? 'bg-white text-black border-white font-bold'
                      : 'bg-zinc-950 text-zinc-400 border-zinc-800 hover:text-white'
                  }`}
                >
                  {r === 'jupiter' ? 'Jupiter V6' : r === 'jito' ? 'Jito MEV' : 'Raydium/GMGN'}
                </button>
              ))}
            </div>
          </div>

          {/* Priority Fee & Jito MEV Tip */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="p-3 rounded border border-zinc-850 bg-black">
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-zinc-400 font-semibold">PRIORITY FEE (SOL)</label>
                <span className="text-[10px] text-zinc-500">Vitesse réseau Solana</span>
              </div>
              <input
                type="number"
                step="0.001"
                min="0.0001"
                value={priorityFee}
                onChange={(e) => setPriorityFee(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-white font-bold text-sm focus:outline-none focus:border-white"
              />
            </div>

            <div className="p-3 rounded border border-zinc-850 bg-black">
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-zinc-400 font-semibold">POURBOIRE JITO MEV (SOL)</label>
                <span className="text-[10px] text-zinc-500">Protection anti-frontrun</span>
              </div>
              <input
                type="number"
                step="0.001"
                min="0.0001"
                value={jitoTip}
                onChange={(e) => setJitoTip(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-white font-bold text-sm focus:outline-none focus:border-white"
              />
            </div>
          </div>

          <button
            type="submit"
            className="w-full py-3 rounded bg-white text-black font-bold uppercase tracking-wider hover:bg-zinc-200 transition-colors cursor-pointer text-sm shadow-sm flex items-center justify-center gap-2"
          >
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
            Enregistrer & Sauvegarder la Configuration
          </button>
        </form>
      </div>
    </div>
  );
};
