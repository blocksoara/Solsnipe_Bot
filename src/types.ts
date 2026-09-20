export interface GMGNConditionCheck {
  id: string;
  name: string;
  passed: boolean;
  rule: string;
  actualValue: string;
  details: string;
}

export interface GMGNAnalysisReport {
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  priceUsd: number;
  marketCapUsd: number;
  volume24hUsd: number;
  volume1hUsd: number;
  top10HoldersPercent: number;
  buyersCount: number;
  sellersCount: number;
  hasDescription: boolean;
  hasWebsite: boolean;
  hasSocial: boolean;
  websiteUrl?: string;
  twitterUrl?: string;
  telegramUrl?: string;
  socialActive: boolean;
  kolCount: number;
  smartWalletCount: number;
  isMintRenounced?: boolean;
  isFreezeRenounced?: boolean;
  isHoneypot?: boolean;
  conditions: GMGNConditionCheck[];
  allPassed: boolean;
  decision: 'SNIPED' | 'REJECTED';
  evaluatedAt: number;
  rawMetrics?: Record<string, unknown>;
}

export interface TelegramCall {
  id: string;
  messageId: number | string;
  channel: string;
  channels?: string[];
  callCount?: number;
  lastAlertTime?: number;
  timestamp: number;
  rawText: string;
  tokenAddress: string;
  tokenSymbol?: string;
  tokenName?: string;
  claimedMarketCap?: string;
  claimedAge?: string;
  status: 'PENDING' | 'ANALYZING' | 'SNIPED' | 'REJECTED';
  analysis?: GMGNAnalysisReport;
  error?: string;
  isHistorical?: boolean;
  canAutoSnipe?: boolean;
}

export interface ActivePosition {
  id: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  entryPriceUsd: number;
  entryPriceSol: number;
  currentPriceUsd: number;
  currentPriceSol: number;
  peakPriceUsd: number;
  amountSol: number;
  amountTokens: number;
  pnlUsd: number;
  pnlPercent: number;
  tpPriceUsd: number;
  slPriceUsd: number;
  trailingStopPriceUsd: number;
  tpPercent: number;
  slPercent: number;
  trailingStopPercent: number;
  openedAt: number;
  lastUpdated: number;
  router: 'jupiter' | 'jito' | 'gmgn';
  executionMode: 'simulation' | 'wallet';
  txHash?: string;
  status: 'OPEN' | 'CLOSED';
  exitReason?: string;
  closedAt?: number;
}

export interface TradeHistoryItem {
  id: string;
  tokenAddress: string;
  tokenSymbol: string;
  buyPriceUsd: number;
  sellPriceUsd: number;
  amountSol: number;
  realizedPnlUsd: number;
  realizedPnlPercent: number;
  openedAt: number;
  closedAt: number;
  exitReason: string;
  router: string;
  executionMode: 'simulation' | 'wallet';
}

export interface SniperConfig {
  autoSnipe: boolean;
  tradingAmountSol: number;
  takeProfitPercent: number;
  stopLossPercent: number;
  trailingStopPercent: number;
  slippagePercent: number;
  router: 'jupiter' | 'jito' | 'gmgn';
  executionMode: 'simulation' | 'wallet';
  priorityFeeSol: number;
  jitoTipSol: number;
  walletPublicKey: string;
  hasPrivateKey: boolean;
  walletBalanceSol?: number;
}

export interface TelegramStatus {
  channel: string;
  channels: string[];
  connected: boolean;
  listenerType: 'live_channel' | 'mtproto' | 'dual';
  totalCallsDetected: number;
  totalUniqueTokens: number;
  totalDuplicatesFiltered: number;
  channelCounts?: Record<string, number>;
  lastCallTime?: number;
  lastCheckTime: number;
  isPhoneAuthPending?: boolean;
  phone?: string;
  statusMessage?: string;
  isAuthenticated?: boolean;
  userName?: string;
  phoneCodeSent?: boolean;
  channelErrors?: Record<string, string>;
}

export interface DexscreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: {
    address: string;
    name: string;
    symbol: string;
  };
  quoteToken: {
    address: string;
    name: string;
    symbol: string;
  };
  priceNative: string;
  priceUsd: string;
  liquidity?: {
    usd: number;
    base: number;
    quote: number;
  };
  volume?: {
    h24: number;
    h6: number;
    h1: number;
    m5: number;
  };
  priceChange?: {
    m5: number;
    h1: number;
    h6: number;
    h24: number;
  };
  txns?: {
    h1?: { buys: number; sells: number };
    h24?: { buys: number; sells: number };
  };
}
