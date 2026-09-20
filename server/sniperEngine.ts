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
  GMGNAnalysisReport,
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
    slippagePercent: 5,
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
            this.tradeHistory = saved.tradeHistory;
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
    targets: { tpPercent?: number; slPercent?: number; trailingStopPercent?: number }
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

    console.log(`[SniperEngine] SNIPING TOKEN: ${report.tokenSymbol} (${tokenAddress}) with ${amountSol} SOL [Mode: ${this.config.executionMode.toUpperCase()}]`);

    // Fetch fresh price from Dexscreener or use report price
    const pair = await this.dexscreener.getTokenPair(tokenAddress);
    const entryPriceUsd = pair ? Number(pair.priceUsd) : (report.priceUsd || 0.0001);
    const entryPriceSol = pair ? Number(pair.priceNative) : 0.000001;

    // Calculate token count based on SOL price
    const solPriceUsd = entryPriceSol > 0 ? entryPriceUsd / entryPriceSol : 150;
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
      pnlPercent: 0,
      tpPriceUsd,
      slPriceUsd,
      trailingStopPriceUsd,
      tpPercent: this.config.takeProfitPercent,
      slPercent: this.config.stopLossPercent,
      trailingStopPercent: this.config.trailingStopPercent,
      openedAt: Date.now(),
      lastUpdated: Date.now(),
      router: this.config.router,
      executionMode: finalExecutionMode,
      txHash,
      status: 'OPEN',
    };

    this.activePositions.set(position.id, position);
    this.saveStateToDisk();
    console.log(`[SniperEngine] Position opened: ${position.tokenSymbol} @ $${entryPriceUsd} (TP: +${position.tpPercent}%, SL: -${position.slPercent}%, Trailing: ${position.trailingStopPercent}%)`);

    if (this.onPositionUpdate) {
      this.onPositionUpdate(this.getActivePositions());
    }

    return position;
  }

  /**
   * Sells an active position (full or partial) with live on-chain execution if in wallet mode
   */
  public async sellPosition(
    positionId: string,
    percent: number = 100,
    reason: string = 'Manual Sell'
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

    // Fetch latest price
    const pair = await this.dexscreener.getTokenPair(position.tokenAddress);
    const sellPriceUsd = pair ? Number(pair.priceUsd) : position.currentPriceUsd;

    const pnlPercent = position.entryPriceUsd > 0
      ? ((sellPriceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100
      : 0;

    const solPriceUsd = position.entryPriceSol > 0 ? position.entryPriceUsd / position.entryPriceSol : 150;
    const clampedPercent = Math.max(1, Math.min(100, percent));
    const soldRatio = clampedPercent / 100;
    const soldAmountSol = position.amountSol * soldRatio;
    const initialUsd = soldAmountSol * solPriceUsd;
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
   * Continuous price tracking and TP / SL / Trailing Stop trigger checker
   */
  private startPriceTracker() {
    this.trackingInterval = setInterval(async () => {
      const positions = Array.from(this.activePositions.values());
      if (positions.length === 0) return;

      const addresses = positions.map((p) => p.tokenAddress);
      const pairsMap = await this.dexscreener.getBatchTokenPairs(addresses);

      let hasChanges = false;

      for (const pos of positions) {
        const pair = pairsMap.get(pos.tokenAddress);
        if (!pair) continue;

        const currentPriceUsd = Number(pair.priceUsd);
        if (currentPriceUsd <= 0) continue;

        pos.currentPriceUsd = currentPriceUsd;
        pos.currentPriceSol = Number(pair.priceNative || pos.currentPriceSol);
        pos.lastUpdated = Date.now();

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

        const solPriceUsd = pos.entryPriceSol > 0 ? pos.entryPriceUsd / pos.entryPriceSol : 150;
        const initialUsd = pos.amountSol * solPriceUsd;
        pos.pnlUsd = (initialUsd * pos.pnlPercent) / 100;
        hasChanges = true;

        // ==========================================
        // EXIT CONDITIONS ENGINE:
        // ==========================================

        // 1. Take Profit (active if > 0)
        if (pos.tpPercent > 0 && currentPriceUsd >= pos.tpPriceUsd) {
          console.log(`[SniperEngine] 🎯 TAKE PROFIT TRIGGERED: ${pos.tokenSymbol} reached $${currentPriceUsd} (+${pos.pnlPercent.toFixed(2)}% >= +${pos.tpPercent}%)`);
          await this.sellPosition(pos.id, 100, `Take Profit Hit (+${pos.pnlPercent.toFixed(1)}%)`);
          continue;
        }

        // 2. Stop Loss (active if > 0)
        if (pos.slPercent > 0 && currentPriceUsd <= pos.slPriceUsd) {
          console.log(`[SniperEngine] 🛑 STOP LOSS TRIGGERED: ${pos.tokenSymbol} dropped to $${currentPriceUsd} (${pos.pnlPercent.toFixed(2)}% <= -${pos.slPercent}%)`);
          await this.sellPosition(pos.id, 100, `Stop Loss Triggered (${pos.pnlPercent.toFixed(1)}%)`);
          continue;
        }

        // 3. Trailing Stop (active if > 0, price moved into profit, and retreated by trailingStopPercent from peak)
        if (
          pos.trailingStopPercent > 0 &&
          pos.peakPriceUsd > pos.entryPriceUsd &&
          currentPriceUsd <= pos.trailingStopPriceUsd
        ) {
          console.log(`[SniperEngine] 📉 TRAILING STOP TRIGGERED: ${pos.tokenSymbol} pulled back to $${currentPriceUsd} (-${pos.trailingStopPercent}% from peak $${pos.peakPriceUsd})`);
          await this.sellPosition(pos.id, 100, `Trailing Stop Triggered (-${pos.trailingStopPercent}% from peak)`);
          continue;
        }
      }

      if (hasChanges && this.onPositionUpdate) {
        this.onPositionUpdate(this.getActivePositions());
      }
    }, 2500);
  }

  public destroy() {
    if (this.trackingInterval) {
      clearInterval(this.trackingInterval);
      this.trackingInterval = null;
    }
  }
}

