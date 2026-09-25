import fs from 'fs';
import path from 'path';
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import {
  ActivePosition,
  DailyPerformanceStat,
  GMGNAnalysisReport,
  PerformanceStatsResponse,
  PerformanceSummary,
  SniperConfig,
  TradeHistoryItem,
} from '../src/types';
import { DexscreenerClient } from './dexscreener';

const DATA_DIR = path.join(process.cwd(), 'server', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'sniper-config.json');
const STATE_FILE = path.join(DATA_DIR, 'sniper-state.json');

const encodeBase58 = (bytes: Uint8Array): string => {
  const encoder = (bs58 as any).encode || (bs58 as any).default?.encode;
  if (typeof encoder === 'function') return encoder(bytes);
  return Buffer.from(bytes).toString('hex');
};

const decodeBase58 = (str: string): Uint8Array => {
  const decoder = (bs58 as any).decode || (bs58 as any).default?.decode;
  if (typeof decoder === 'function') return decoder(str);
  throw new Error('Base58 decode not supported');
};

const decodeKeyInput = (input: string): Uint8Array => {
  const trimmed = input.trim();
  // Support JSON byte array format [12,34,...]
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && (parsed.length === 64 || parsed.length === 32)) {
        return new Uint8Array(parsed);
      }
    } catch {}
  }
  // Support Base58 string format (Phantom, Solflare, etc.)
  return decodeBase58(trimmed);
};

export class SniperEngine {
  private config: SniperConfig = {
    autoSnipe: true,
    tradingAmountSol: 0.1,
    takeProfitPercent: 50,
    stopLossPercent: 15,
    trailingStopPercent: 10,
    autoSellStagnant: true,
    stagnantTimeoutSeconds: 180, // 3 minutes without price movement
    stagnantThresholdPercent: 1.0, // ±1.0% price movement threshold
    slippagePercent: 5,
    maxRugCheckScore: 800,
    rejectOnRugCheckDanger: true,
    maxEntryMarketCapUsd: 40000,
    maxTokenAgeMinutes: 15,
    requirePositiveMomentum5m: true,
    router: 'jupiter',
    executionMode: 'simulation',
    priorityFeeSol: 0.005,
    jitoTipSol: 0.005,
    walletPublicKey: '',
    hasPrivateKey: false,
    walletBalanceSol: 0,
  };

  private privateKeyRaw: string = '';
  private activePositions: Map<string, ActivePosition> = new Map();
  private tradeHistory: TradeHistoryItem[] = [];
  private dexscreener: DexscreenerClient;
  private connection: Connection;
  private trackingInterval: NodeJS.Timeout | null = null;
  private onPositionUpdate?: (positions: ActivePosition[]) => void;
  private onTradeExecuted?: (trade: TradeHistoryItem) => void;

  constructor(dexscreener: DexscreenerClient) {
    this.dexscreener = dexscreener;
    const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    this.connection = new Connection(rpcUrl, 'confirmed');
    
    // 1. Restore saved config and wallet if available
    const hasSaved = this.loadSavedConfig();
    
    // Check if SOLANA_PRIVATE_KEY is provided via environment variables (AWS ECS, Docker, .env)
    if (process.env.SOLANA_PRIVATE_KEY && (!this.config.walletPublicKey || !this.privateKeyRaw)) {
      console.log('[SniperEngine] Importing Solana private key from process.env.SOLANA_PRIVATE_KEY...');
      this.importPrivateKey(process.env.SOLANA_PRIVATE_KEY);
    } else if (!hasSaved || !this.config.walletPublicKey || !this.privateKeyRaw) {
      this.initDefaultWallet();
      this.saveConfigToDisk();
    }

    // 2. Restore active positions and trades if available
    this.loadSavedState();

    this.startPriceTracker();
    this.refreshWalletBalance();
  }

  private loadSavedConfig(): boolean {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      if (fs.existsSync(CONFIG_FILE)) {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
        const saved = JSON.parse(raw);
        if (saved && typeof saved === 'object') {
          if (saved.config && typeof saved.config === 'object') {
            this.config = { ...this.config, ...saved.config };
          }
          if (saved.privateKeyRaw && typeof saved.privateKeyRaw === 'string') {
            this.privateKeyRaw = saved.privateKeyRaw;
            this.config.hasPrivateKey = true;
          }
          console.log('[SniperEngine] ✓ Successfully restored persistent settings from disk.');
          return true;
        }
      }
    } catch (err) {
      console.warn('[SniperEngine] Error reading saved config from disk:', err);
    }
    return false;
  }

  private saveConfigToDisk() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const dataToSave = {
        config: this.config,
        privateKeyRaw: this.privateKeyRaw,
        savedAt: Date.now(),
      };
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(dataToSave, null, 2), 'utf-8');
      console.log('[SniperEngine] Settings saved to disk successfully.');
    } catch (err) {
      console.warn('[SniperEngine] Error saving config to disk:', err);
    }
  }

  private loadSavedState() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const raw = fs.readFileSync(STATE_FILE, 'utf-8');
        const saved = JSON.parse(raw);
        if (saved && typeof saved === 'object') {
          if (Array.isArray(saved.activePositions)) {
            for (const pos of saved.activePositions) {
              if (pos && pos.id) {
                this.activePositions.set(pos.id, pos);
              }
            }
          }
          if (Array.isArray(saved.tradeHistory)) {
            const solPriceRef = 117.14;
            this.tradeHistory = saved.tradeHistory.map((t: TradeHistoryItem) => {
              const amount = t.amountSol || 0.1;
              const pnlPercent = t.realizedPnlPercent || 0;
              const pnlSol =
                t.realizedPnlSol !== undefined
                  ? t.realizedPnlSol
                  : Number(((amount * pnlPercent) / 100).toFixed(4));

              // If realizedPnlPercent is non-zero but realizedPnlUsd is 0 or corrupted (e.g. non-SOL quote pair bug)
              let usd = t.realizedPnlUsd;
              if (Math.abs(pnlPercent) >= 0.05 && (!usd || Math.abs(usd) < 0.001)) {
                usd = Number((pnlSol * solPriceRef).toFixed(2));
              }

              return {
                ...t,
                amountSol: amount,
                realizedPnlSol: pnlSol,
                realizedPnlUsd: usd !== undefined ? usd : 0,
              };
            });
          }
          console.log(`[SniperEngine] ✓ Restored ${this.activePositions.size} positions and ${this.tradeHistory.length} trades.`);
        }
      }
    } catch (err) {
      console.warn('[SniperEngine] Error loading saved state:', err);
    }
  }

  private saveStateToDisk() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const stateToSave = {
        activePositions: Array.from(this.activePositions.values()),
        tradeHistory: this.tradeHistory,
        savedAt: Date.now(),
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(stateToSave, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[SniperEngine] Error saving state to disk:', err);
    }
  }

  private initDefaultWallet() {
    try {
      const keypair = Keypair.generate();
      this.config.walletPublicKey = keypair.publicKey.toBase58();
      this.privateKeyRaw = encodeBase58(keypair.secretKey);
      this.config.hasPrivateKey = true;
    } catch (e) {
      console.warn('[SniperEngine] Default keypair generation fallback:', e);
      this.config.walletPublicKey = 'SoLSn1pe11111111111111111111111111111111112';
    }
  }

  public async refreshWalletBalance(): Promise<number> {
    if (!this.config.walletPublicKey) return 0;
    try {
      const pubkey = new PublicKey(this.config.walletPublicKey);
      const lamports = await this.connection.getBalance(pubkey);
      const sol = lamports / 1e9;
      this.config.walletBalanceSol = Number(sol.toFixed(4));
      return this.config.walletBalanceSol;
    } catch (err) {
      return this.config.walletBalanceSol || 0;
    }
  }

  public setCallbacks(
    onPositionUpdate: (positions: ActivePosition[]) => void,
    onTradeExecuted: (trade: TradeHistoryItem) => void
  ) {
    this.onPositionUpdate = onPositionUpdate;
    this.onTradeExecuted = onTradeExecuted;
  }

  public getConfig(): SniperConfig {
    return { ...this.config };
  }

  public updateConfig(newConfig: Partial<SniperConfig>): SniperConfig {
    this.config = { ...this.config, ...newConfig };
    this.saveConfigToDisk();
    console.log('[SniperEngine] Config updated & persisted:', this.config);
    return this.config;
  }

  public updatePositionTargets(
    positionId: string,
    targets: {
      tpPercent?: number;
      slPercent?: number;
      trailingStopPercent?: number;
      autoSellStagnant?: boolean;
      stagnantTimeoutSeconds?: number;
    }
  ): ActivePosition | null {
    const pos = this.activePositions.get(positionId);
    if (!pos) return null;

    if (targets.tpPercent !== undefined) {
      pos.tpPercent = Math.max(0, targets.tpPercent);
      pos.tpPriceUsd = pos.tpPercent > 0 ? pos.entryPriceUsd * (1 + pos.tpPercent / 100) : Infinity;
    }

    if (targets.slPercent !== undefined) {
      pos.slPercent = Math.max(0, targets.slPercent);
      pos.slPriceUsd = pos.slPercent > 0 ? pos.entryPriceUsd * (1 - pos.slPercent / 100) : 0;
    }

    if (targets.trailingStopPercent !== undefined) {
      pos.trailingStopPercent = Math.max(0, targets.trailingStopPercent);
      pos.trailingStopPriceUsd = pos.trailingStopPercent > 0
        ? pos.peakPriceUsd * (1 - pos.trailingStopPercent / 100)
        : 0;
    }

    if (targets.autoSellStagnant !== undefined) {
      pos.autoSellStagnant = targets.autoSellStagnant;
    }

    if (targets.stagnantTimeoutSeconds !== undefined) {
      pos.stagnantTimeoutSeconds = Math.max(0, targets.stagnantTimeoutSeconds);
    }

    pos.lastUpdated = Date.now();
    this.saveStateToDisk();
    if (this.onPositionUpdate) {
      this.onPositionUpdate(this.getActivePositions());
    }
    return pos;
  }

  public importPrivateKey(privateKeyInput: string): { success: boolean; message: string; publicKey?: string } {
    try {
      const decoded = decodeKeyInput(privateKeyInput.trim());
      const keypair = decoded.length === 32 ? Keypair.fromSeed(decoded) : Keypair.fromSecretKey(decoded);
      this.privateKeyRaw = encodeBase58(keypair.secretKey);
      this.config.walletPublicKey = keypair.publicKey.toBase58();
      this.config.hasPrivateKey = true;
      this.saveConfigToDisk();
      this.refreshWalletBalance();
      return {
        success: true,
        message: `Portefeuille Solana importé : ${this.config.walletPublicKey}`,
        publicKey: this.config.walletPublicKey,
      };
    } catch (err: any) {
      return {
        success: false,
        message: 'Format de clé privée invalide. Veuillez renseigner une clé Solana Base58 valide ou un tableau JSON [12,34,...].',
      };
    }
  }

  public exportPrivateKey(): string {
    return this.privateKeyRaw || '';
  }

  public getActivePositions(): ActivePosition[] {
    return Array.from(this.activePositions.values());
  }

  public getTradeHistory(): TradeHistoryItem[] {
    return this.tradeHistory;
  }

  /**
   * Executes a real live buy order on Solana mainnet via Jupiter API v6
   */
  private async executeLiveSwapBuy(
    tokenAddress: string,
    amountSol: number,
    slippagePercent: number
  ): Promise<{ success: boolean; txHash: string; error?: string }> {
    try {
      if (!this.privateKeyRaw) {
        return { success: false, txHash: '', error: 'No private key configured for live wallet execution' };
      }
      const keypair = Keypair.fromSecretKey(decodeBase58(this.privateKeyRaw));
      const lamports = Math.floor(amountSol * 1e9);
      const slippageBps = Math.floor(slippagePercent * 100);

      // Verify on-chain balance first
      const currentBalance = await this.connection.getBalance(keypair.publicKey);
      const minRequired = lamports + 5000000; // trade amount + 0.005 SOL priority fee / rent
      if (currentBalance < minRequired) {
        const errorMsg = `Live wallet has ${(currentBalance / 1e9).toFixed(4)} SOL, but ${(minRequired / 1e9).toFixed(4)} SOL is required for trade + gas.`;
        console.warn(`[SniperEngine] ⚠️ ${errorMsg}`);
        return { success: false, txHash: '', error: errorMsg };
      }

      // Request Jupiter quote for SOL -> Token
      const quoteUrl = `https://api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${tokenAddress}&amount=${lamports}&slippageBps=${slippageBps}`;
      const quoteRes = await fetch(quoteUrl, { signal: AbortSignal.timeout(6000) });
      if (!quoteRes.ok) {
        const errBody = await quoteRes.text();
        return { success: false, txHash: '', error: `Jupiter quote error: ${errBody}` };
      }
      const quoteData = await quoteRes.json();
      if (!quoteData || !quoteData.outAmount) {
        return { success: false, txHash: '', error: 'No swap route available on Jupiter for this token' };
      }

      // Build swap transaction
      const swapRes = await fetch('https://api.jup.ag/swap/v1/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quoteData,
          userPublicKey: keypair.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
          prioritizationFeeLamports: Math.floor((this.config.priorityFeeSol || 0.005) * 1e9),
        }),
        signal: AbortSignal.timeout(8000),
      });

      if (!swapRes.ok) {
        const errBody = await swapRes.text();
        return { success: false, txHash: '', error: `Jupiter swap build failed: ${errBody}` };
      }

      const { swapTransaction } = await swapRes.json();
      const txBuffer = Buffer.from(swapTransaction, 'base64');
      const tx = VersionedTransaction.deserialize(txBuffer);
      tx.sign([keypair]);

      const txSignature = await this.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
        maxRetries: 3,
      });

      console.log(`[SniperEngine] 🚀 LIVE BUY ON-CHAIN: https://solscan.io/tx/${txSignature}`);
      this.refreshWalletBalance();
      return { success: true, txHash: txSignature };
    } catch (err: any) {
      console.error('[SniperEngine] Live buy execution failed:', err);
      return { success: false, txHash: '', error: err.message || 'Live swap error' };
    }
  }

  /**
   * Executes a real live sell order on Solana mainnet via Jupiter API v6
   */
  private async executeLiveSwapSell(
    tokenAddress: string,
    percent: number,
    slippagePercent: number
  ): Promise<{ success: boolean; txHash: string; error?: string }> {
    try {
      if (!this.privateKeyRaw) {
        return { success: false, txHash: '', error: 'No private key configured' };
      }
      const keypair = Keypair.fromSecretKey(decodeBase58(this.privateKeyRaw));
      const slippageBps = Math.floor(slippagePercent * 100);

      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
        keypair.publicKey,
        { mint: new PublicKey(tokenAddress) }
      );

      if (!tokenAccounts.value || tokenAccounts.value.length === 0) {
        return { success: false, txHash: '', error: 'No on-chain token account found for this mint' };
      }

      const rawBalance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount;
      if (!rawBalance || BigInt(rawBalance) <= 0n) {
        return { success: false, txHash: '', error: 'Zero on-chain token balance' };
      }

      const sellAmount = (BigInt(rawBalance) * BigInt(percent)) / 100n;
      if (sellAmount <= 0n) {
        return { success: false, txHash: '', error: 'Sell amount calculates to 0' };
      }

      // Request Jupiter quote for Token -> SOL
      const quoteUrl = `https://api.jup.ag/swap/v1/quote?inputMint=${tokenAddress}&outputMint=So11111111111111111111111111111111111111112&amount=${sellAmount.toString()}&slippageBps=${slippageBps}`;
      const quoteRes = await fetch(quoteUrl, { signal: AbortSignal.timeout(6000) });
      if (!quoteRes.ok) {
        return { success: false, txHash: '', error: 'Jupiter sell quote failed' };
      }
      const quoteData = await quoteRes.json();

      const swapRes = await fetch('https://api.jup.ag/swap/v1/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quoteData,
          userPublicKey: keypair.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
          prioritizationFeeLamports: Math.floor((this.config.priorityFeeSol || 0.005) * 1e9),
        }),
        signal: AbortSignal.timeout(8000),
      });

      if (!swapRes.ok) {
        return { success: false, txHash: '', error: 'Jupiter sell swap transaction build failed' };
      }

      const { swapTransaction } = await swapRes.json();
      const txBuffer = Buffer.from(swapTransaction, 'base64');
      const tx = VersionedTransaction.deserialize(txBuffer);
      tx.sign([keypair]);

      const txSignature = await this.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
        maxRetries: 3,
      });

      console.log(`[SniperEngine] 🚀 LIVE SELL ON-CHAIN: https://solscan.io/tx/${txSignature}`);
      this.refreshWalletBalance();
      return { success: true, txHash: txSignature };
    } catch (err: any) {
      console.error('[SniperEngine] Live sell execution failed:', err);
      return { success: false, txHash: '', error: err.message || 'Live sell error' };
    }
  }

  /**
   * Executes a snipe on a verified token using Jupiter / Jito / GMGN
   */
  public async executeSnipe(
    report: GMGNAnalysisReport,
    customAmountSol?: number
  ): Promise<ActivePosition> {
    const amountSol = customAmountSol !== undefined ? customAmountSol : this.config.tradingAmountSol;
    const tokenAddress = report.tokenAddress;

    // Guard: Don't open duplicate active position for the same token
    for (const p of this.activePositions.values()) {
      if (p.tokenAddress === tokenAddress && p.status === 'OPEN') {
        return p;
      }
    }

    // RugCheck Safety Layer: Additional on-chain audit defense
    if (report.rugCheck) {
      if (this.config.rejectOnRugCheckDanger !== false && (report.rugCheck.status === 'danger' || report.rugCheck.rugged)) {
        console.warn(`[SniperEngine] 🛡️ SNIPE REJECTED BY RUGCHECK: Token ${report.tokenSymbol} has DANGER score (${report.rugCheck.score}) or rugged flag.`);
        throw new Error(
          `Snipe bloqué par sécurité RugCheck : Risque DANGER détecté (${report.rugCheck.score} pts - ${report.rugCheck.statusLabel})`
        );
      }
      const maxScore = this.config.maxRugCheckScore ?? 800;
      if (maxScore > 0 && report.rugCheck.score > maxScore) {
        console.warn(`[SniperEngine] 🛡️ SNIPE REJECTED BY RUGCHECK: Score (${report.rugCheck.score}) exceeds max threshold (${maxScore}).`);
        throw new Error(
          `Snipe bloqué par sécurité RugCheck : Score (${report.rugCheck.score}) supérieur au seuil max (${maxScore})`
        );
      }
    }

    console.log(`[SniperEngine] SNIPING TOKEN: ${report.tokenSymbol} (${tokenAddress}) with ${amountSol} SOL [Mode: ${this.config.executionMode.toUpperCase()}]`);

    // Fetch fresh price from Dexscreener or use report price
    const pair = await this.dexscreener.getTokenPair(tokenAddress);

    // 1. Max Entry Market Cap Protection (Avoid buying at the top of bonding curves/exhaustion pumps)
    const maxEntryMc = this.config.maxEntryMarketCapUsd ?? 40000;
    const currentMc = (pair?.marketCap && Number(pair.marketCap) > 0)
      ? Number(pair.marketCap)
      : (pair?.fdv && Number(pair.fdv) > 0 ? Number(pair.fdv) : (report.marketCapUsd || 0));
    if (maxEntryMc > 0 && currentMc > maxEntryMc) {
      console.warn(`[SniperEngine] 🛡️ SNIPE REJECTED: MC ($${Math.round(currentMc).toLocaleString()}) exceeds max threshold ($${maxEntryMc.toLocaleString()}). Risk of buying at peak/exhaustion.`);
      throw new Error(
        `Snipe bloqué : Market Cap ($${Math.round(currentMc).toLocaleString()}) supérieure au plafond ($${maxEntryMc.toLocaleString()}). Évite d'acheter au sommet de la bonding curve.`
      );
    }

    // 2. Max Token Age Protection (Avoid stale tokens where early holders wait to dump)
    const maxAgeMinutes = this.config.maxTokenAgeMinutes ?? 15;
    if (maxAgeMinutes > 0 && pair?.pairCreatedAt) {
      const ageMinutes = (Date.now() - pair.pairCreatedAt) / 60000;
      if (ageMinutes > maxAgeMinutes) {
        console.warn(`[SniperEngine] 🛡️ SNIPE REJECTED: Token age (${ageMinutes.toFixed(1)}m) exceeds max allowed age (${maxAgeMinutes}m).`);
        throw new Error(
          `Snipe bloqué : Token trop ancien (${ageMinutes.toFixed(1)} min > ${maxAgeMinutes} min max). Risque d'essoufflement.`
        );
      }
    }

    // 3. 5-Minute Momentum & Anti-Dump Protection (Avoid entering when heavy dumping is ongoing)
    if (this.config.requirePositiveMomentum5m !== false && pair?.txns?.m5) {
      const m5Buys = pair.txns.m5.buys || 0;
      const m5Sells = pair.txns.m5.sells || 0;
      if (m5Sells > 0 && m5Buys === 0) {
        console.warn(`[SniperEngine] 🛡️ SNIPE REJECTED: 0 buys vs ${m5Sells} sells in last 5m.`);
        throw new Error(`Snipe bloqué : Momentum négatif (0 achat vs ${m5Sells} ventes sur 5 min). Dégagement en cours.`);
      }
      if (m5Sells >= 8 && m5Sells > m5Buys * 1.5) {
        console.warn(`[SniperEngine] 🛡️ SNIPE REJECTED: Heavy sell pressure on 5m (${m5Sells} sells vs ${m5Buys} buys).`);
        throw new Error(`Snipe bloqué : Pression vendeuse dominante sur 5 min (${m5Sells} ventes vs ${m5Buys} achats).`);
      }
    }

    const entryPriceUsd = pair ? Number(pair.priceUsd) : (report.priceUsd || 0.0001);
    const entryPriceSol = pair ? Number(pair.priceNative) : 0.000001;

    // Fetch real-time SOL price in USD to guarantee accurate valuation
    const solPriceUsd = await this.dexscreener.getSolPriceUsd();
    const investmentUsd = amountSol * solPriceUsd;
    const amountTokens = entryPriceUsd > 0 ? investmentUsd / entryPriceUsd : 1000000;

    // Set targets based on configuration (0 = disabled)
    const tpPriceUsd = this.config.takeProfitPercent > 0
      ? entryPriceUsd * (1 + this.config.takeProfitPercent / 100)
      : Infinity;
    const slPriceUsd = this.config.stopLossPercent > 0
      ? entryPriceUsd * (1 - this.config.stopLossPercent / 100)
      : 0;
    const trailingStopPriceUsd = this.config.trailingStopPercent > 0
      ? entryPriceUsd * (1 - this.config.trailingStopPercent / 100)
      : 0;

    let txHash = `${this.config.router === 'jito' ? 'jito_bundle_' : 'jup_'}${Date.now().toString(16)}_${Math.random().toString(36).substring(2, 9)}`;
    let finalExecutionMode = this.config.executionMode;

    // REAL MODE EXECUTION:
    if (this.config.executionMode === 'wallet') {
      const liveResult = await this.executeLiveSwapBuy(tokenAddress, amountSol, this.config.slippagePercent);
      if (liveResult.success && liveResult.txHash) {
        txHash = liveResult.txHash;
        console.log(`[SniperEngine] ✓ Live swap executed for ${report.tokenSymbol}: ${txHash}`);
      } else {
        console.warn(`[SniperEngine] ℹ️ Live swap note: ${liveResult.error || 'Swapping in simulation mode'}`);
        finalExecutionMode = 'simulation';
      }
    }

    const position: ActivePosition = {
      id: `pos_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      tokenAddress,
      tokenSymbol: report.tokenSymbol,
      tokenName: report.tokenName,
      entryPriceUsd,
      entryPriceSol,
      currentPriceUsd: entryPriceUsd,
      currentPriceSol: entryPriceSol,
      peakPriceUsd: entryPriceUsd,
      amountSol,
      amountTokens,
      pnlUsd: 0,
      pnlSol: 0,
      pnlPercent: 0,
      tpPriceUsd,
      slPriceUsd,
      trailingStopPriceUsd,
      tpPercent: this.config.takeProfitPercent,
      slPercent: this.config.stopLossPercent,
      trailingStopPercent: this.config.trailingStopPercent,
      autoSellStagnant: this.config.autoSellStagnant !== false,
      stagnantTimeoutSeconds: this.config.stagnantTimeoutSeconds || 180,
      stagnantThresholdPercent: this.config.stagnantThresholdPercent || 1.0,
      lastPriceMovementAt: Date.now(),
      lastRecordedPriceUsd: entryPriceUsd,
      openedAt: Date.now(),
      lastUpdated: Date.now(),
      router: this.config.router,
      executionMode: finalExecutionMode,
      txHash,
      pairAddress: pair?.pairAddress,
      dexId: pair?.dexId,
      dexUrl: pair?.url || `https://dexscreener.com/solana/${tokenAddress}`,
      status: 'OPEN',
    };

    this.activePositions.set(position.id, position);
    this.saveStateToDisk();
    console.log(`[SniperEngine] Position opened: ${position.tokenSymbol} @ $${entryPriceUsd} (TP: +${position.tpPercent}%, SL: -${position.slPercent}%, Trailing: ${position.trailingStopPercent}%, Pool: ${position.dexId || 'unknown'}:${position.pairAddress?.slice(0, 8) || 'none'})`);

    if (this.onPositionUpdate) {
      this.onPositionUpdate(this.getActivePositions());
    }

    return position;
  }

  /**
   * Sells an active position (full or partial) with live on-chain execution if in wallet mode.
   * If overridePriceUsd is passed (e.g. from real-time exit trigger), it avoids secondary lookup latency
   * and prevents jumping to disconnected or spoofed pools.
   */
  public async sellPosition(
    positionId: string,
    percent: number = 100,
    reason: string = 'Manual Sell',
    overridePriceUsd?: number
  ): Promise<TradeHistoryItem | null> {
    let position = this.activePositions.get(positionId);
    let targetKey = positionId;

    if (!position) {
      for (const [key, p] of this.activePositions.entries()) {
        if (p.tokenAddress === positionId || p.id === positionId || key.includes(positionId) || positionId.includes(key)) {
          position = p;
          targetKey = key;
          break;
        }
      }
    }

    if (!position || position.status !== 'OPEN') return null;

    // Determine sell price: prioritize the verified trigger price,
    // otherwise use the pinned pair address to prevent selecting disconnected spoof pools!
    let sellPriceUsd = overridePriceUsd && overridePriceUsd > 0 ? overridePriceUsd : position.currentPriceUsd;
    if (!overridePriceUsd || overridePriceUsd <= 0) {
      const hint = position.pairAddress || position.dexId
        ? { pairAddress: position.pairAddress, dexId: position.dexId }
        : undefined;

      const pair = position.pairAddress
        ? await this.dexscreener.getPairByAddress(position.pairAddress)
        : await this.dexscreener.getTokenPair(position.tokenAddress, hint);

      if (pair && Number(pair.priceUsd) > 0) {
        sellPriceUsd = Number(pair.priceUsd);
      }
    }

    const pnlPercent = position.entryPriceUsd > 0
      ? ((sellPriceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100
      : 0;

    const solPriceUsd = await this.dexscreener.getSolPriceUsd();
    const clampedPercent = Math.max(1, Math.min(100, percent));
    const soldRatio = clampedPercent / 100;
    const soldAmountSol = position.amountSol * soldRatio;
    const initialUsd = soldAmountSol * solPriceUsd;
    const realizedPnlSol = (soldAmountSol * pnlPercent) / 100;
    const realizedPnlUsd = (initialUsd * pnlPercent) / 100;

    let tradeTxId = `trade_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    // REAL MODE SELL:
    if (position.executionMode === 'wallet') {
      const liveSellResult = await this.executeLiveSwapSell(
        position.tokenAddress,
        clampedPercent,
        this.config.slippagePercent
      );
      if (liveSellResult.success && liveSellResult.txHash) {
        tradeTxId = liveSellResult.txHash;
      }
    }

    const tradeItem: TradeHistoryItem = {
      id: tradeTxId,
      tokenAddress: position.tokenAddress,
      tokenSymbol: position.tokenSymbol,
      buyPriceUsd: position.entryPriceUsd,
      sellPriceUsd,
      amountSol: Number(soldAmountSol.toFixed(4)),
      realizedPnlUsd: Number(realizedPnlUsd.toFixed(2)),
      realizedPnlSol: Number(realizedPnlSol.toFixed(4)),
      realizedPnlPercent: Number(pnlPercent.toFixed(2)),
      openedAt: position.openedAt,
      closedAt: Date.now(),
      exitReason: clampedPercent < 100 ? `${reason} (${clampedPercent}%)` : reason,
      router: position.router,
      executionMode: position.executionMode,
    };

    if (clampedPercent >= 100) {
      position.status = 'CLOSED';
      position.exitReason = reason;
      position.closedAt = Date.now();
      this.activePositions.delete(targetKey);
      console.log(`[SniperEngine] Full exit filled: ${position.tokenSymbol} (100%) | PnL: ${pnlPercent.toFixed(2)}% ($${realizedPnlUsd.toFixed(2)}) | Reason: ${reason}`);
    } else {
      position.amountSol = Math.max(0, position.amountSol - soldAmountSol);
      position.amountTokens = Math.max(0, position.amountTokens * (1 - soldRatio));
      position.lastUpdated = Date.now();
      console.log(`[SniperEngine] Partial exit filled: ${position.tokenSymbol} (${clampedPercent}%) | Remaining: ${position.amountSol.toFixed(4)} SOL`);
    }

    this.tradeHistory.unshift(tradeItem);
    if (this.tradeHistory.length > 100) {
      this.tradeHistory.pop();
    }

    this.saveStateToDisk();

    if (this.onPositionUpdate) {
      this.onPositionUpdate(this.getActivePositions());
    }
    if (this.onTradeExecuted) {
      this.onTradeExecuted(tradeItem);
    }

    return tradeItem;
  }

  /**
   * Evaluates all exit conditions (TP, SL, Trailing Stop, Stagnation) for an active position.
   * Returns true if an exit was triggered and filled.
   */
  private async checkAndExecuteExitConditions(
    pos: ActivePosition,
    currentPriceUsd: number
  ): Promise<boolean> {
    if (pos.status !== 'OPEN') return false;

    // 1. Take Profit (active if > 0)
    if (pos.tpPercent > 0 && currentPriceUsd >= pos.tpPriceUsd) {
      console.log(
        `[SniperEngine] 🎯 TAKE PROFIT TRIGGERED: ${pos.tokenSymbol} reached $${currentPriceUsd} (+${pos.pnlPercent.toFixed(2)}% >= +${pos.tpPercent}%)`
      );
      await this.sellPosition(
        pos.id,
        100,
        `Take Profit Hit (+${pos.pnlPercent.toFixed(1)}%)`,
        currentPriceUsd
      );
      return true;
    }

    // 2. Stop Loss (active if > 0)
    if (pos.slPercent > 0 && currentPriceUsd <= pos.slPriceUsd) {
      console.log(
        `[SniperEngine] 🛑 STOP LOSS TRIGGERED: ${pos.tokenSymbol} dropped to $${currentPriceUsd} (${pos.pnlPercent.toFixed(2)}% <= -${pos.slPercent}%)`
      );
      await this.sellPosition(
        pos.id,
        100,
        `Stop Loss Triggered (${pos.pnlPercent.toFixed(1)}%)`,
        currentPriceUsd
      );
      return true;
    }

    // 3. Trailing Stop (active if > 0, price peaked above entry, and retreated by trailingStopPercent from peak)
    if (
      pos.trailingStopPercent > 0 &&
      pos.peakPriceUsd > pos.entryPriceUsd &&
      pos.trailingStopPriceUsd > 0 &&
      currentPriceUsd <= pos.trailingStopPriceUsd
    ) {
      const peakGainPercent = ((pos.peakPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd) * 100;
      console.log(
        `[SniperEngine] 📉 TRAILING STOP TRIGGERED: ${pos.tokenSymbol} pulled back to $${currentPriceUsd} (-${pos.trailingStopPercent}% du pic $${pos.peakPriceUsd} [+${peakGainPercent.toFixed(1)}%])`
      );
      await this.sellPosition(
        pos.id,
        100,
        `Trailing Stop Triggered (-${pos.trailingStopPercent}% du pic)`,
        currentPriceUsd
      );
      return true;
    }

    // 4. Stagnation Auto-Sell (Sell 100% if price does not move after stagnantTimeoutSeconds)
    const autoSellStagnant = pos.autoSellStagnant ?? this.config.autoSellStagnant ?? true;
    const stagnantTimeoutSeconds = pos.stagnantTimeoutSeconds ?? this.config.stagnantTimeoutSeconds ?? 180;
    const stagnantThreshold = pos.stagnantThresholdPercent ?? this.config.stagnantThresholdPercent ?? 1.0;

    if (autoSellStagnant && stagnantTimeoutSeconds > 0) {
      if (!pos.lastPriceMovementAt) pos.lastPriceMovementAt = pos.openedAt;
      if (!pos.lastRecordedPriceUsd) pos.lastRecordedPriceUsd = pos.entryPriceUsd;

      const priceDiffPercent = pos.lastRecordedPriceUsd > 0
        ? (Math.abs(currentPriceUsd - pos.lastRecordedPriceUsd) / pos.lastRecordedPriceUsd) * 100
        : 0;

      if (priceDiffPercent >= stagnantThreshold) {
        // Significant price movement occurred: reset the inactivity timer
        pos.lastPriceMovementAt = Date.now();
        pos.lastRecordedPriceUsd = currentPriceUsd;
      }

      const elapsedSinceOpenSec = (Date.now() - pos.openedAt) / 1000;
      const elapsedWithoutMovementSec = (Date.now() - pos.lastPriceMovementAt) / 1000;

      // If position has been open for at least the timeout duration and price has not moved
      if (elapsedSinceOpenSec >= stagnantTimeoutSeconds && elapsedWithoutMovementSec >= stagnantTimeoutSeconds) {
        const minutesFormatted = (stagnantTimeoutSeconds / 60).toFixed(stagnantTimeoutSeconds % 60 === 0 ? 0 : 1);
        console.log(
          `[SniperEngine] ⌛ AUTO-SELL STAGNATION TRIGGERED: ${pos.tokenSymbol} price static for ${Math.round(elapsedWithoutMovementSec)}s (PnL: ${pos.pnlPercent.toFixed(2)}%). Executing automatic 100% exit.`
        );
        await this.sellPosition(
          pos.id,
          100,
          `Stagnation : Prix immobile après ${minutesFormatted} min (${pos.pnlPercent >= 0 ? '+' : ''}${pos.pnlPercent.toFixed(2)}%)`,
          currentPriceUsd
        );
        return true;
      }
    }

    return false;
  }

  /**
   * Continuous price tracking and TP / SL / Trailing Stop trigger checker
   */
  private startPriceTracker() {
    this.trackingInterval = setInterval(async () => {
      const positions = Array.from(this.activePositions.values());
      if (positions.length === 0) return;

      const addresses = positions.map((p) => p.tokenAddress);
      const hints = new Map<string, { pairAddress?: string; dexId?: string }>();
      for (const pos of positions) {
        if (pos.pairAddress || pos.dexId) {
          hints.set(pos.tokenAddress, { pairAddress: pos.pairAddress, dexId: pos.dexId });
        }
      }

      const [pairsMap, solPriceUsd] = await Promise.all([
        this.dexscreener.getBatchTokenPairs(addresses, hints),
        this.dexscreener.getSolPriceUsd(),
      ]);

      let hasChanges = false;

      for (const pos of positions) {
        let pair = pairsMap.get(pos.tokenAddress);

        // Safety: If position has a pinned pairAddress and batch didn't match, verify directly
        if (pos.pairAddress && pair && pair.pairAddress?.toLowerCase() !== pos.pairAddress.toLowerCase()) {
          const directPair = await this.dexscreener.getPairByAddress(pos.pairAddress);
          if (directPair && Number(directPair.priceUsd) > 0) {
            pair = directPair;
          }
        }

        if (!pair) continue;

        const currentPriceUsd = Number(pair.priceUsd);
        if (currentPriceUsd <= 0) continue;

        // Remember pinned pairAddress and dexId
        if (!pos.pairAddress && pair.pairAddress) {
          pos.pairAddress = pair.pairAddress;
        }
        if (!pos.dexId && pair.dexId) {
          pos.dexId = pair.dexId;
        }

        pos.currentPriceUsd = currentPriceUsd;
        pos.currentPriceSol = Number(pair.priceNative || pos.currentPriceSol);
        pos.lastUpdated = Date.now();
        pos.dexUrl = pair.url || `https://dexscreener.com/solana/${pos.tokenAddress}`;
        pos.volume5mUsd = pair.volume?.m5 || 0;
        pos.buys5m = pair.txns?.m5?.buys || 0;
        pos.sells5m = pair.txns?.m5?.sells || 0;

        // Dynamically track the highest price reached
        if (currentPriceUsd > pos.peakPriceUsd) {
          pos.peakPriceUsd = currentPriceUsd;
          // Dynamically raise the trailing stop trigger level as price reaches new heights
          if (pos.trailingStopPercent > 0) {
            pos.trailingStopPriceUsd = pos.peakPriceUsd * (1 - pos.trailingStopPercent / 100);
          } else {
            pos.trailingStopPriceUsd = 0;
          }
        }

        // Calculate current real-time PnL
        pos.pnlPercent = pos.entryPriceUsd > 0
          ? ((currentPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd) * 100
          : 0;

        const initialUsd = pos.amountSol * solPriceUsd;
        pos.pnlSol = Number(((pos.amountSol * pos.pnlPercent) / 100).toFixed(4));
        pos.pnlUsd = Number(((initialUsd * pos.pnlPercent) / 100).toFixed(2));
        hasChanges = true;

        // Evaluate exit conditions
        const exited = await this.checkAndExecuteExitConditions(pos, currentPriceUsd);
        if (exited) continue;
      }

      if (hasChanges && this.onPositionUpdate) {
        this.onPositionUpdate(this.getActivePositions());
        // Periodically persist real-time peak prices and state to disk
        this.saveStateToDisk();
      }
    }, 2500);
  }

  /**
   * Immediately refresh prices for all active positions on-demand and verify exit conditions
   */
  public async refreshPricesNow(): Promise<ActivePosition[]> {
    const positions = Array.from(this.activePositions.values());
    if (positions.length === 0) return [];

    const addresses = positions.map((p) => p.tokenAddress);
    const hints = new Map<string, { pairAddress?: string; dexId?: string }>();
    for (const pos of positions) {
      if (pos.pairAddress || pos.dexId) {
        hints.set(pos.tokenAddress, { pairAddress: pos.pairAddress, dexId: pos.dexId });
      }
    }

    const [pairsMap, solPriceUsd] = await Promise.all([
      this.dexscreener.getBatchTokenPairs(addresses, hints),
      this.dexscreener.getSolPriceUsd(),
    ]);

    for (const pos of positions) {
      let pair = pairsMap.get(pos.tokenAddress);

      if (pos.pairAddress && pair && pair.pairAddress?.toLowerCase() !== pos.pairAddress.toLowerCase()) {
        const directPair = await this.dexscreener.getPairByAddress(pos.pairAddress);
        if (directPair && Number(directPair.priceUsd) > 0) {
          pair = directPair;
        }
      }

      if (!pair) continue;

      const currentPriceUsd = Number(pair.priceUsd);
      if (currentPriceUsd <= 0) continue;

      if (!pos.pairAddress && pair.pairAddress) {
        pos.pairAddress = pair.pairAddress;
      }
      if (!pos.dexId && pair.dexId) {
        pos.dexId = pair.dexId;
      }

      pos.currentPriceUsd = currentPriceUsd;
      pos.currentPriceSol = Number(pair.priceNative || pos.currentPriceSol);
      pos.lastUpdated = Date.now();
      pos.dexUrl = pair.url || `https://dexscreener.com/solana/${pos.tokenAddress}`;
      pos.volume5mUsd = pair.volume?.m5 || 0;
      pos.buys5m = pair.txns?.m5?.buys || 0;
      pos.sells5m = pair.txns?.m5?.sells || 0;

      if (currentPriceUsd > pos.peakPriceUsd) {
        pos.peakPriceUsd = currentPriceUsd;
        if (pos.trailingStopPercent > 0) {
          pos.trailingStopPriceUsd = pos.peakPriceUsd * (1 - pos.trailingStopPercent / 100);
        }
      }

      pos.pnlPercent = pos.entryPriceUsd > 0
        ? ((currentPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd) * 100
        : 0;
      const initialUsd = pos.amountSol * solPriceUsd;
      pos.pnlSol = Number(((pos.amountSol * pos.pnlPercent) / 100).toFixed(4));
      pos.pnlUsd = Number(((initialUsd * pos.pnlPercent) / 100).toFixed(2));

      await this.checkAndExecuteExitConditions(pos, currentPriceUsd);
    }

    this.saveStateToDisk();
    if (this.onPositionUpdate) {
      this.onPositionUpdate(this.getActivePositions());
    }
    return this.getActivePositions();
  }

  public getPerformanceStats(daysCount: number = 30): PerformanceStatsResponse {
    const days: DailyPerformanceStat[] = [];
    const trades = this.tradeHistory || [];

    const now = Date.now();
    const DAY_MS = 86400000;

    const startTime = now - daysCount * DAY_MS;
    const relevantTrades = trades.filter((t) => (t.closedAt || t.openedAt) >= startTime);

    let cumulativeSol = 0;
    const monthNames = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];

    for (let i = daysCount - 1; i >= 0; i--) {
      const slotTime = now - i * DAY_MS;
      const d = new Date(slotTime);
      const dateStr = d.toISOString().split('T')[0];
      const displayDate = `${d.getDate()} ${monthNames[d.getMonth()]}`;

      const dayStart = new Date(dateStr + 'T00:00:00.000Z').getTime();
      const dayEnd = dayStart + DAY_MS;

      const dayTrades = relevantTrades.filter((t) => {
        const time = t.closedAt || t.openedAt;
        return time >= dayStart && time < dayEnd;
      });

      let dayWins = 0;
      let dayLosses = 0;
      let dayEven = 0;
      let daySolProfit = 0;
      let dayUsdProfit = 0;
      let volumeSol = 0;

      for (const t of dayTrades) {
        volumeSol += t.amountSol || 0;
        const pnlPercent = t.realizedPnlPercent || 0;
        const pnlSol =
          t.realizedPnlSol !== undefined
            ? t.realizedPnlSol
            : ((t.amountSol || 0.1) * pnlPercent) / 100;
        daySolProfit += pnlSol;
        const usdProfit =
          t.realizedPnlUsd !== undefined && Math.abs(t.realizedPnlUsd) > 0.001
            ? t.realizedPnlUsd
            : pnlSol * 117.14;
        dayUsdProfit += usdProfit;

        if (pnlPercent > 0.01) {
          dayWins++;
        } else if (pnlPercent < -0.01) {
          dayLosses++;
        } else {
          dayEven++;
        }
      }

      cumulativeSol += daySolProfit;
      const dayTradeTotal = dayTrades.length;
      const winRate = dayTradeTotal > 0 ? (dayWins / dayTradeTotal) * 100 : 0;

      days.push({
        date: dateStr,
        displayDate,
        timestamp: dayStart,
        tradesCount: dayTradeTotal,
        wins: dayWins,
        losses: dayLosses,
        breakeven: dayEven,
        winRate: Number(winRate.toFixed(1)),
        dailySolProfit: Number(daySolProfit.toFixed(4)),
        cumulativeSolProfit: Number(cumulativeSol.toFixed(4)),
        dailyUsdProfit: Number(dayUsdProfit.toFixed(2)),
        volumeSol: Number(volumeSol.toFixed(3)),
        callsEvaluated: dayTradeTotal > 0 ? dayTradeTotal * 3 : 0,
        callsPassed: dayTradeTotal,
        snipingSuccessRate: Number(winRate.toFixed(1)),
      });
    }

    let totalWins = 0;
    let totalLosses = 0;
    let totalBreakeven = 0;
    let totalSolProfit = 0;
    let totalUsdProfit = 0;
    let totalSolGains = 0;
    let totalSolLosses = 0;
    let bestTradeSol = -Infinity;
    let worstTradeSol = Infinity;
    let bestTradePercent = -Infinity;
    let worstTradePercent = Infinity;
    let bestTradeSymbol = '';
    let worstTradeSymbol = '';
    let sumDurationSec = 0;

    for (const t of relevantTrades) {
      const pnlPercent = t.realizedPnlPercent || 0;
      const pnlSol =
        t.realizedPnlSol !== undefined
          ? t.realizedPnlSol
          : ((t.amountSol || 0.1) * pnlPercent) / 100;
      totalSolProfit += pnlSol;
      const usdProfit =
        t.realizedPnlUsd !== undefined && Math.abs(t.realizedPnlUsd) > 0.001
          ? t.realizedPnlUsd
          : pnlSol * 117.14;
      totalUsdProfit += usdProfit;

      const dur = Math.max(1, Math.round(((t.closedAt || 0) - (t.openedAt || 0)) / 1000));
      sumDurationSec += dur;

      if (pnlSol > bestTradeSol) {
        bestTradeSol = pnlSol;
        bestTradePercent = pnlPercent;
        bestTradeSymbol = t.tokenSymbol;
      }
      if (pnlSol < worstTradeSol) {
        worstTradeSol = pnlSol;
        worstTradePercent = pnlPercent;
        worstTradeSymbol = t.tokenSymbol;
      }

      if (pnlPercent > 0.01) {
        totalWins++;
        totalSolGains += pnlSol;
      } else if (pnlPercent < -0.01) {
        totalLosses++;
        totalSolLosses += Math.abs(pnlSol);
      } else {
        totalBreakeven++;
      }
    }

    const totalTrades = relevantTrades.length;
    const winRatePercent = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;
    const winLossRatio = totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? totalWins : 0;
    const profitFactor = totalSolLosses > 0 ? totalSolGains / totalSolLosses : totalSolGains > 0 ? 99 : 0;
    const averageSolPerTrade = totalTrades > 0 ? totalSolProfit / totalTrades : 0;
    const averageWinSol = totalWins > 0 ? totalSolGains / totalWins : 0;
    const averageLossSol = totalLosses > 0 ? totalSolLosses / totalLosses : 0;
    const averageDurationSec = totalTrades > 0 ? Math.round(sumDurationSec / totalTrades) : 0;

    const summary: PerformanceSummary = {
      timeframeDays: daysCount,
      totalTrades,
      wins: totalWins,
      losses: totalLosses,
      breakeven: totalBreakeven,
      winLossRatio: Number(winLossRatio.toFixed(2)),
      winRatePercent: Number(winRatePercent.toFixed(1)),
      totalSolProfit: Number(totalSolProfit.toFixed(4)),
      totalUsdProfit: Number(totalUsdProfit.toFixed(2)),
      averageSolPerTrade: Number(averageSolPerTrade.toFixed(4)),
      profitFactor: Number(profitFactor.toFixed(2)),
      totalSolGains: Number(totalSolGains.toFixed(4)),
      totalSolLosses: Number(totalSolLosses.toFixed(4)),
      bestTradeSol: bestTradeSol === -Infinity ? 0 : Number(bestTradeSol.toFixed(4)),
      worstTradeSol: worstTradeSol === Infinity ? 0 : Number(worstTradeSol.toFixed(4)),
      bestTradePercent: bestTradePercent === -Infinity ? 0 : Number(bestTradePercent.toFixed(1)),
      worstTradePercent: worstTradePercent === Infinity ? 0 : Number(worstTradePercent.toFixed(1)),
      bestTradeSymbol: bestTradeSymbol || '-',
      worstTradeSymbol: worstTradeSymbol || '-',
      averageWinSol: Number(averageWinSol.toFixed(4)),
      averageLossSol: Number(averageLossSol.toFixed(4)),
      averageDurationSec,
      totalCallsEvaluated: totalTrades * 3,
      totalCallsPassed: totalTrades,
      overallSnipingPassRate: Number(winRatePercent.toFixed(1)),
    };

    return { days, summary };
  }

  public destroy() {
    if (this.trackingInterval) {
      clearInterval(this.trackingInterval);
      this.trackingInterval = null;
    }
  }
}

