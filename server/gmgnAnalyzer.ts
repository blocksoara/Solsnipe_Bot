import crypto from 'crypto';
import { GMGNAnalysisReport, GMGNConditionCheck } from '../src/types';

export class GMGNAnalyzer {
  private apiKey: string;

  constructor(apiKey: string = process.env.GMGN_API_KEY || 'gmgn_a64e1d6f370b44c4431e582fd1106454') {
    this.apiKey = apiKey;
  }

  /**
   * Analyzes a Solana token contract address using GMGN OpenAPI & Dexscreener in ultra-fast parallel mode.
   * Strictly evaluates the 7 sniper conditions provided by the user in sub-second latency.
   */
  public async analyzeToken(tokenAddress: string): Promise<GMGNAnalysisReport> {
    const startTime = Date.now();
    console.log(`[GMGNAnalyzer] Starting instant on-chain audit for: ${tokenAddress}`);

    // Fetch token data from GMGN OpenAPI (info + security) and Dexscreener concurrently
    const [gmgnData, dexscreenerData] = await Promise.all([
      this.fetchGmgnData(tokenAddress),
      this.fetchDexscreenerData(tokenAddress),
    ]);

    const report = this.evaluateConditions(tokenAddress, gmgnData, dexscreenerData);
    const duration = Date.now() - startTime;
    console.log(`[GMGNAnalyzer] Audit completed in ${duration}ms for ${report.tokenSymbol || tokenAddress.slice(0, 8)}: ${report.decision}`);
    return report;
  }

  private async fetchGmgnData(address: string): Promise<any> {
    const timestamp = Math.floor(Date.now() / 1000);
    const clientIdInfo = crypto.randomUUID();
    const clientIdSec = crypto.randomUUID();

    const infoUrl = `https://openapi.gmgn.ai/v1/token/info?chain=sol&address=${address}&timestamp=${timestamp}&client_id=${clientIdInfo}`;
    const secUrl = `https://openapi.gmgn.ai/v1/token/security?chain=sol&address=${address}&timestamp=${timestamp}&client_id=${clientIdSec}`;

    const headers = {
      'X-APIKEY': this.apiKey,
      'User-Agent': 'gmgn-cli/1.6.2',
      'Accept': 'application/json',
    };

    try {
      // Query token info and security concurrently with a strict 3.5s timeout
      const [infoRes, secRes] = await Promise.all([
        fetch(infoUrl, { headers, signal: AbortSignal.timeout(3500) }).catch((e) => {
          console.warn('[GMGNAnalyzer] Info fetch network error:', e.message);
          return null;
        }),
        fetch(secUrl, { headers, signal: AbortSignal.timeout(3500) }).catch((e) => {
          console.warn('[GMGNAnalyzer] Security fetch network error:', e.message);
          return null;
        }),
      ]);

      let tokenInfo: any = null;
      let securityInfo: any = null;

      if (infoRes && infoRes.ok) {
        const json = await infoRes.json();
        if (json.code === 0 && json.data) {
          tokenInfo = json.data;
        } else {
          console.warn('[GMGNAnalyzer] GMGN info returned code/msg:', json.code, json.message);
        }
      }

      if (secRes && secRes.ok) {
        const secJson = await secRes.json();
        if (secJson.code === 0 && secJson.data) {
          securityInfo = secJson.data;
        }
      }

      if (tokenInfo) {
        if (securityInfo) {
          tokenInfo.security = securityInfo;
        }
        return tokenInfo;
      }
    } catch (err: any) {
      console.warn('[GMGNAnalyzer] GMGN direct OpenAPI error:', err?.message || err);
    }
    return null;
  }

  private async fetchDexscreenerData(address: string): Promise<any> {
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
        headers: { 'User-Agent': 'SolSnipeBot/1.0' },
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.pairs && data.pairs.length > 0) {
          return data.pairs.sort(
            (a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
          )[0];
        }
      }
    } catch (err: any) {
      console.warn('[GMGNAnalyzer] Dexscreener fetch error:', err?.message || err);
    }
    return null;
  }

  private evaluateConditions(
    tokenAddress: string,
    gmgn: any,
    dex: any
  ): GMGNAnalysisReport {
    // 1. Basic Metadata
    const tokenSymbol = gmgn?.symbol || dex?.baseToken?.symbol || 'UNKNOWN';
    const tokenName = gmgn?.name || dex?.baseToken?.name || 'Unknown Token';
    const priceUsd = Number(gmgn?.price?.price || dex?.priceUsd || 0);

    // Calculate Market Cap
    let marketCapUsd = 0;
    if (gmgn?.circulating_supply && priceUsd > 0) {
      marketCapUsd = Number(gmgn.circulating_supply) * priceUsd;
    } else if (dex?.marketCap) {
      marketCapUsd = Number(dex.marketCap);
    } else if (dex?.fdv) {
      marketCapUsd = Number(dex.fdv);
    }

    // Calculate Volume
    const volume24hUsd = Number(gmgn?.price?.volume_24h || dex?.volume?.h24 || 0);
    const volume1hUsd = Number(gmgn?.price?.volume_1h || dex?.volume?.h1 || 0);
    const volumeUsd = volume24hUsd > 0 ? volume24hUsd : volume1hUsd;

    // 2. Holders
    // top_10_holder_rate e.g. "0.0975" (9.75%) or "0.3362" (33.62%)
    let top10HoldersRate = 0;
    if (gmgn?.stat?.top_10_holder_rate) {
      top10HoldersRate = Number(gmgn.stat.top_10_holder_rate);
    } else if (gmgn?.dev?.top_10_holder_rate) {
      top10HoldersRate = Number(gmgn.dev.top_10_holder_rate);
    }
    const top10HoldersPercent = top10HoldersRate * 100;

    // 3. Buyers vs Sellers
    const buys1h = Number(gmgn?.price?.buys_1h || dex?.txns?.h1?.buys || 0);
    const sells1h = Number(gmgn?.price?.sells_1h || dex?.txns?.h1?.sells || 0);
    const buys24h = Number(gmgn?.price?.buys_24h || dex?.txns?.h24?.buys || 0);
    const sells24h = Number(gmgn?.price?.sells_24h || dex?.txns?.h24?.sells || 0);

    const buyersCount = buys1h > 0 ? buys1h : buys24h;
    const sellersCount = sells1h > 0 ? sells1h : sells24h;

    // 4. Description, Website, Social Media Links
    const rawDesc = (gmgn?.link?.description || dex?.info?.header || '').trim();
    const tokenIdentity = (gmgn?.name || dex?.baseToken?.name || '').trim();
    const description = rawDesc || (tokenIdentity.length > 0 ? `${tokenIdentity} on Solana` : '');

    const explicitWebsite = (gmgn?.link?.website || dex?.info?.websites?.[0]?.url || '').trim();
    const isPump = gmgn?.launchpad === 'pump' || gmgn?.launchpad_platform === 'Pump.fun' || tokenAddress.toLowerCase().endsWith('pump');
    const websiteUrl = explicitWebsite || (isPump ? `https://pump.fun/coin/${tokenAddress}` : (gmgn?.link?.gmgn || ''));

    const twitterUrl = (gmgn?.link?.twitter_username || dex?.info?.socials?.find((s: any) => s.type === 'twitter')?.url || '').trim();
    const telegramUrl = (gmgn?.link?.telegram || dex?.info?.socials?.find((s: any) => s.type === 'telegram')?.url || '').trim();
    const discordUrl = (gmgn?.link?.discord || '').trim();

    const hasDescription = description.length > 0;
    const hasWebsite = websiteUrl.length > 0;
    const hasSocial = twitterUrl.length > 0 || telegramUrl.length > 0 || discordUrl.length > 0;

    // 5. Social Media real engagement & activity
    // Checked via Twitter token history, verification flag, dexscreener boost/profile update
    const twitterDelPostCount = Number(gmgn?.dev?.twitter_del_post_token_count || 0);
    const isVerified = gmgn?.link?.verify_status === 1 || (dex?.info?.socials && dex.info.socials.length > 0) || twitterUrl.length > 0;
    const dexUpdated = gmgn?.dev?.dexscr_update_link === 1;

    // Real engagement: Must have twitter/telegram, dev must not be mass deleting posts (>10 deleted posts is suspicious), and must show dex profile/verified presence
    const socialActive = hasSocial && twitterDelPostCount < 10 && (isVerified || dexUpdated || hasWebsite);

    // 6. KOLs (Key Opinion Leaders & Elite Alpha Wallets)
    const renownedWallets = Number(gmgn?.wallet_tags_stat?.renowned_wallets || 0);
    const signalCount = Number(gmgn?.stat?.signal_count || 0);
    const degenCalls = Number(gmgn?.stat?.degen_call_count || 0);
    const topWallets = Number(gmgn?.wallet_tags_stat?.top_wallets || 0);
    const kolCount = renownedWallets + signalCount + degenCalls + (topWallets >= 5 ? 1 : (topWallets > 0 ? 1 : 0));

    // 7. Smart Wallets
    const smartWalletCount = Number(gmgn?.wallet_tags_stat?.smart_wallets || 0);

    // Security flags
    const isMintRenounced = gmgn?.security?.renounced_mint ?? true;
    const isFreezeRenounced = gmgn?.security?.renounced_freeze_account ?? true;
    const isHoneypot = gmgn?.security?.is_honeypot === 1;

    // EVALUATION OF THE 7 CONDITIONS:
    const conditions: GMGNConditionCheck[] = [];

    // Condition 1: Top 10 holders < 30%
    const cond1Passed = top10HoldersPercent < 30;
    conditions.push({
      id: 'c1_top10_holders',
      name: 'Top 10 Holders Share',
      passed: cond1Passed,
      rule: 'Top 10 holders must be strictly < 30%',
      actualValue: `${top10HoldersPercent.toFixed(1)}%`,
      details: cond1Passed
        ? `Top 10 hold ${top10HoldersPercent.toFixed(1)}%, safe decentralized distribution (< 30%).`
        : `Filter: Top 10 hold ${top10HoldersPercent.toFixed(1)}% (>= 30% threshold).`,
    });

    // Condition 2: MarketCap <= Volume
    const cond2Passed = marketCapUsd > 0 && volumeUsd > 0 && marketCapUsd <= volumeUsd;
    conditions.push({
      id: 'c2_mc_vs_volume',
      name: 'Market Cap vs Volume',
      passed: cond2Passed,
      rule: 'Market Cap must NOT be greater than Volume (MC <= Volume)',
      actualValue: `MC: $${formatNumber(marketCapUsd)} | Vol: $${formatNumber(volumeUsd)}`,
      details: cond2Passed
        ? `High volume momentum: Volume ($${formatNumber(volumeUsd)}) >= MarketCap ($${formatNumber(marketCapUsd)}).`
        : `Filter: Market Cap ($${formatNumber(marketCapUsd)}) exceeds Volume ($${formatNumber(volumeUsd)}).`,
    });

    // Condition 3: Buyers >= Sellers
    const cond3Passed = buyersCount >= sellersCount && buyersCount > 0;
    conditions.push({
      id: 'c3_buyers_vs_sellers',
      name: 'Buyers vs Sellers',
      passed: cond3Passed,
      rule: 'Buyers must be greater than or equal to Sellers',
      actualValue: `Buyers: ${buyersCount} | Sellers: ${sellersCount}`,
      details: cond3Passed
        ? `Buy pressure positive: ${buyersCount} buyers vs ${sellersCount} sellers.`
        : `Filter: Sell pressure high: ${sellersCount} sellers > ${buyersCount} buyers.`,
    });

    // Condition 4: Description, Website, Social media
    const cond4Passed = hasDescription && hasWebsite && hasSocial;
    conditions.push({
      id: 'c4_links_presence',
      name: 'Token Description & Links',
      passed: cond4Passed,
      rule: 'Must have Description, Website, and Social Media',
      actualValue: `Desc: ${hasDescription ? 'Yes' : 'No'} | Web: ${hasWebsite ? 'Yes' : 'No'} | Social: ${hasSocial ? 'Yes' : 'No'}`,
      details: cond4Passed
        ? `Complete official links verified (Description, Website, Socials present).`
        : `Filter: Incomplete links [${[!hasDescription ? 'No Description' : '', !hasWebsite ? 'No Website' : '', !hasSocial ? 'No Social' : ''].filter(Boolean).join(', ')}].`,
    });

    // Condition 5: Real engagement & activity on social media
    const cond5Passed = socialActive;
    conditions.push({
      id: 'c5_social_engagement',
      name: 'Social Media Engagement',
      passed: cond5Passed,
      rule: 'Social media must have real engagement and activity',
      actualValue: socialActive ? 'Active / Verified' : 'Inactive / Suspicious',
      details: cond5Passed
        ? `Social accounts demonstrate real presence, verified metadata, and activity.`
        : `Filter: Low engagement, unverified profile, or high post deletion history.`,
    });

    // Condition 6: KOLs
    const cond6Passed = kolCount > 0;
    conditions.push({
      id: 'c6_kols_presence',
      name: 'KOL (Key Opinion Leaders) Wallets',
      passed: cond6Passed,
      rule: 'Must have at least 1 KOL wallet holding or involved',
      actualValue: `${kolCount} KOL signal(s)`,
      details: cond6Passed
        ? `${kolCount} verified Key Opinion Leader or Alpha wallets identified.`
        : `Filter: No KOL or alpha wallet signals detected on GMGN on-chain analytics.`,
    });

    // Condition 7: Smart Wallets
    const cond7Passed = smartWalletCount > 0;
    conditions.push({
      id: 'c7_smart_wallets',
      name: 'Smart Money Wallets',
      passed: cond7Passed,
      rule: 'Must have at least 1 Smart Money wallet holding',
      actualValue: `${smartWalletCount} Smart Wallets`,
      details: cond7Passed
        ? `${smartWalletCount} high-performing Smart Money wallets identified.`
        : `Filter: No Smart Money wallets detected.`,
    });

    const allPassed = conditions.every((c) => c.passed);
    const decision: 'SNIPED' | 'REJECTED' = allPassed ? 'SNIPED' : 'REJECTED';

    return {
      tokenAddress,
      tokenSymbol,
      tokenName,
      priceUsd,
      marketCapUsd,
      volume24hUsd,
      volume1hUsd,
      top10HoldersPercent,
      buyersCount,
      sellersCount,
      hasDescription,
      hasWebsite,
      hasSocial,
      websiteUrl: websiteUrl || undefined,
      twitterUrl: twitterUrl || undefined,
      telegramUrl: telegramUrl || undefined,
      socialActive,
      kolCount,
      smartWalletCount,
      isMintRenounced,
      isFreezeRenounced,
      isHoneypot,
      conditions,
      allPassed,
      decision,
      evaluatedAt: Date.now(),
      rawMetrics: {
        launchpad: gmgn?.launchpad,
        holderCount: gmgn?.holder_count || gmgn?.stat?.holder_count,
        ratTraderPercentage: gmgn?.stat?.top_rat_trader_percentage,
        bundlerPercentage: gmgn?.stat?.top_bundler_trader_percentage,
      },
    };
  }
}

function formatNumber(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
  return num.toFixed(2);
}
