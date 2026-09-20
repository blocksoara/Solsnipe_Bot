import { DexscreenerPair } from '../src/types';

export class DexscreenerClient {
  private cache = new Map<string, { data: DexscreenerPair; timestamp: number }>();
  private CACHE_TTL_MS = 2500; // 2.5 seconds cache for fresh prices

  public async getTokenPair(tokenAddress: string): Promise<DexscreenerPair | null> {
    const cached = this.cache.get(tokenAddress);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.data;
    }

    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, {
        headers: {
          'User-Agent': 'SolSnipe/1.0 (Realtime Dexscreener Price Stream)',
          Accept: 'application/json',
        },
      });

      if (!res.ok) {
        return null;
      }

      const json = await res.json();
      if (!json.pairs || json.pairs.length === 0) {
        return null;
      }

      // Filter for Solana chain and find highest liquidity pair
      const solanaPairs = json.pairs.filter((p: any) => p.chainId === 'solana');
      const bestPair = solanaPairs.length > 0
        ? solanaPairs.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0]
        : json.pairs[0];

      this.cache.set(tokenAddress, { data: bestPair, timestamp: Date.now() });
      return bestPair;
    } catch (err) {
      console.warn(`[DexscreenerClient] Error fetching ${tokenAddress}:`, err);
      return null;
    }
  }

  public async getBatchTokenPairs(tokenAddresses: string[]): Promise<Map<string, DexscreenerPair>> {
    const results = new Map<string, DexscreenerPair>();
    if (tokenAddresses.length === 0) return results;

    // Dexscreener allows up to 30 addresses comma-separated
    const chunks: string[][] = [];
    for (let i = 0; i < tokenAddresses.length; i += 30) {
      chunks.push(tokenAddresses.slice(i, i + 30));
    }

    for (const chunk of chunks) {
      try {
        const url = `https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`;
        const res = await fetch(url, {
          headers: { 'User-Agent': 'SolSnipe/1.0' },
        });

        if (res.ok) {
          const json = await res.json();
          if (json.pairs && Array.isArray(json.pairs)) {
            for (const pair of json.pairs) {
              const baseAddr = pair.baseToken?.address;
              if (baseAddr && !results.has(baseAddr)) {
                results.set(baseAddr, pair);
                this.cache.set(baseAddr, { data: pair, timestamp: Date.now() });
              }
            }
          }
        }
      } catch (err) {
        console.warn('[DexscreenerClient] Batch fetch error:', err);
      }
    }

    return results;
  }
}
