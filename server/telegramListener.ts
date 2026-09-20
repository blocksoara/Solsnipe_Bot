import fs from 'fs';
import path from 'path';
import { TelegramCall, TelegramStatus } from '../src/types';

const DATA_DIR = path.join(process.cwd(), 'server', 'data');
const TG_DATA_FILE = path.join(DATA_DIR, 'telegram-auth.json');
const PROCESSED_POSTS_FILE = path.join(DATA_DIR, 'processed-posts.json');

interface TelegramListenerOptions {
  channels?: string[];
  channel?: string;
  apiId: number;
  apiHash: string;
  phone: string;
  onCall: (call: TelegramCall) => void;
  onCallUpdated?: (call: TelegramCall) => void;
}

export class TelegramListener {
  private channels: string[] = [];
  private apiId: number;
  private apiHash: string;
  private phone: string;
  private onCall: (call: TelegramCall) => void;
  private onCallUpdated?: (call: TelegramCall) => void;

  private isRunning = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private processedPostIds = new Set<string>();
  private calls: TelegramCall[] = [];
  private lastCheckTime = Date.now();
  private lastCallTime?: number;
  private phoneCodeHash?: string;
  private gramClient: any = null;
  private isAuthenticated = false;
  private authenticatedUser?: string;

  // Bot launch timestamp and scan state: prevents auto-sniping historical / pre-launch calls
  private botLaunchTime: number = Date.now();
  private isInitialScan: boolean = true;

  // Real-time deduplication & channel metrics
  private totalAlertsReceived = 0;
  private totalDuplicatesFiltered = 0;
  private channelStats: Record<string, number> = {};
  private channelErrors: Record<string, string> = {};
  private invalidChannels: Set<string> = new Set();

  constructor(options: TelegramListenerOptions) {
    const rawChannels = options.channels || (options.channel ? [options.channel] : ['pumpdotfunalert']);
    this.channels = rawChannels.map((c) => this.cleanChannelName(c));
    this.apiId = options.apiId;
    this.apiHash = options.apiHash;
    this.phone = options.phone;
    this.onCall = options.onCall;
    this.onCallUpdated = options.onCallUpdated;

    // Load saved telegram session and custom channels from disk
    this.loadSavedTelegramAuth();

    // Restore previously processed post IDs from disk
    this.loadSavedProcessedPosts();

    // Pre-initialize channel stats
    this.channels.forEach((c) => {
      this.channelStats[`t.me/${c}`] = 0;
    });
  }

  private loadSavedProcessedPosts() {
    try {
      if (fs.existsSync(PROCESSED_POSTS_FILE)) {
        const raw = fs.readFileSync(PROCESSED_POSTS_FILE, 'utf-8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          list.forEach((id: string) => {
            if (typeof id === 'string') this.processedPostIds.add(id);
          });
          console.log(`[TelegramListener] ✓ Restored ${this.processedPostIds.size} processed post IDs from disk.`);
        }
      }
    } catch (err) {
      console.warn('[TelegramListener] Could not read processed posts file:', err);
    }
  }

  private saveProcessedPostsToDisk() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const arr = Array.from(this.processedPostIds).slice(-1500);
      fs.writeFileSync(PROCESSED_POSTS_FILE, JSON.stringify(arr), 'utf-8');
    } catch (err) {
      console.warn('[TelegramListener] Could not save processed posts to disk:', err);
    }
  }

  private loadSavedTelegramAuth() {
    try {
      if (fs.existsSync(TG_DATA_FILE)) {
        const raw = fs.readFileSync(TG_DATA_FILE, 'utf-8');
        const data = JSON.parse(raw);
        if (data && typeof data === 'object') {
          if (data.phone) this.phone = data.phone;
          if (data.authenticatedUser) this.authenticatedUser = data.authenticatedUser;
          if (data.sessionString) {
            this.isAuthenticated = true;
            console.log(`[TelegramListener] ✓ Restored saved Telegram session for ${this.authenticatedUser || this.phone}`);
          }
          if (Array.isArray(data.channels) && data.channels.length > 0) {
            const sanitized = data.channels.filter((c: string) => !c.toLowerCase().includes('bullishcall'));
            this.channels = sanitized.length > 0 ? Array.from(new Set(sanitized)) : ['pumpdotfunalert'];
          }
        }
      }

      // Check environment variables for cloud/AWS container deployment
      if (process.env.TELEGRAM_SESSION_STRING && !this.isAuthenticated) {
        this.isAuthenticated = true;
        console.log('[TelegramListener] ✓ Restored Telegram session from process.env.TELEGRAM_SESSION_STRING');
      }
      if (process.env.TELEGRAM_CHANNELS && (!this.channels || this.channels.length === 0)) {
        const envChannels = process.env.TELEGRAM_CHANNELS.split(/[,;\s]+/).map((c) => this.cleanChannelName(c)).filter(Boolean);
        if (envChannels.length > 0) {
          this.channels = Array.from(new Set(envChannels));
        }
      }
    } catch (err) {
      console.warn('[TelegramListener] Error reading saved Telegram session:', err);
    }
  }

  private saveTelegramAuthToDisk(sessionString?: string) {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      let existingSession = '';
      if (fs.existsSync(TG_DATA_FILE)) {
        try {
          const old = JSON.parse(fs.readFileSync(TG_DATA_FILE, 'utf-8'));
          existingSession = old.sessionString || '';
        } catch {}
      }
      const dataToSave = {
        phone: this.phone,
        authenticatedUser: this.authenticatedUser,
        sessionString: sessionString || existingSession,
        channels: this.channels,
        savedAt: Date.now(),
      };
      fs.writeFileSync(TG_DATA_FILE, JSON.stringify(dataToSave, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[TelegramListener] Error saving Telegram auth to disk:', err);
    }
  }

  public cleanChannelName(channel: string): string {
    if (!channel) return '';
    return channel
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/^(?:www\.)?(?:telegram\.me|t\.me)\//i, '')
      .replace(/^s\//i, '')
      .replace(/^joinchat\//i, '')
      .replace(/^@/, '')
      .replace(/\/.*$/, '')
      .trim();
  }

  public isValidUsername(channel: string): boolean {
    const clean = this.cleanChannelName(channel);
    // Telegram usernames must be 4 to 32 alphanumeric/underscore characters
    return /^[a-zA-Z0-9_]{4,32}$/.test(clean);
  }

  public addChannel(channel: string): boolean {
    const res = this.addChannels(channel);
    return res.added.length > 0;
  }

  public addChannels(channelInputs: string | string[]): { added: string[]; ignored: string[]; invalid: string[] } {
    const list = Array.isArray(channelInputs)
      ? channelInputs
      : channelInputs.split(/[\n,;\s]+/).filter(Boolean);
    const added: string[] = [];
    const ignored: string[] = [];
    const invalid: string[] = [];

    for (const raw of list) {
      const clean = this.cleanChannelName(raw);
      if (!clean) continue;
      if (!this.isValidUsername(clean)) {
        invalid.push(clean);
        continue;
      }
      if (this.channels.some((c) => c.toLowerCase() === clean.toLowerCase())) {
        ignored.push(clean);
        continue;
      }
      // Reset any previous error state for this channel
      delete this.channelErrors[`t.me/${clean}`];
      this.invalidChannels.delete(clean.toLowerCase());

      this.channels.push(clean);
      this.channelStats[`t.me/${clean}`] = 0;
      added.push(clean);
      console.log(`[TelegramListener] Added channel: t.me/${clean}`);
      // Fetch initial posts without auto-sniping historical calls
      this.fetchChannelPostsFor(clean, true).catch(() => {});
    }

    if (added.length > 0) {
      this.saveTelegramAuthToDisk();
    }
    return { added, ignored, invalid };
  }

  public removeChannel(channel: string): boolean {
    const res = this.removeChannels(channel);
    return res.removed.length > 0;
  }

  public removeChannels(channelInputs: string | string[]): { removed: string[] } {
    const list = Array.isArray(channelInputs)
      ? channelInputs
      : channelInputs.split(/[\n,;\s]+/).filter(Boolean);
    const removed: string[] = [];

    for (const raw of list) {
      const clean = this.cleanChannelName(raw);
      if (!clean) continue;
      const initialLen = this.channels.length;
      this.channels = this.channels.filter((c) => c.toLowerCase() !== clean.toLowerCase());
      delete this.channelStats[`t.me/${clean}`];
      delete this.channelErrors[`t.me/${clean}`];
      this.invalidChannels.delete(clean.toLowerCase());
      if (this.channels.length < initialLen) {
        removed.push(clean);
        console.log(`[TelegramListener] Removed channel: t.me/${clean}`);
      }
    }

    if (removed.length > 0) {
      this.saveTelegramAuthToDisk();
    }
    return { removed };
  }

  public clearAllChannels(): void {
    this.channels = [];
    this.channelStats = {};
    this.channelErrors = {};
    this.invalidChannels.clear();
    this.saveTelegramAuthToDisk();
    console.log('[TelegramListener] Cleared all monitored channels.');
  }

  public setChannels(newChannels: string[]): { channels: string[] } {
    const cleaned = Array.from(
      new Set(
        newChannels
          .map((c) => this.cleanChannelName(c))
          .filter((c) => this.isValidUsername(c))
      )
    );
    this.channels = cleaned;
    const newStats: Record<string, number> = {};
    for (const c of cleaned) {
      newStats[`t.me/${c}`] = this.channelStats[`t.me/${c}`] || 0;
    }
    this.channelStats = newStats;
    this.channelErrors = {};
    this.invalidChannels.clear();
    this.saveTelegramAuthToDisk();
    for (const c of cleaned) {
      this.fetchChannelPostsFor(c, true).catch(() => {});
    }
    return { channels: this.channels.map((c) => `t.me/${c}`) };
  }

  public getCalls(): TelegramCall[] {
    const seenAddresses = new Set<string>();
    return this.calls.filter((c) => {
      if (!c || !c.tokenAddress) return false;
      const lower = c.tokenAddress.toLowerCase();
      if (seenAddresses.has(lower)) return false;
      seenAddresses.add(lower);
      return true;
    });
  }

  public getStatus(): TelegramStatus {
    const channelList = this.channels.map((c) => `t.me/${c}`);
    return {
      channel: channelList.join(', '),
      channels: channelList,
      connected: this.isRunning,
      listenerType: this.isAuthenticated ? 'mtproto' : (this.gramClient ? 'dual' : 'live_channel'),
      totalCallsDetected: this.totalAlertsReceived,
      totalUniqueTokens: this.getCalls().length,
      totalDuplicatesFiltered: this.totalDuplicatesFiltered,
      channelCounts: { ...this.channelStats },
      channelErrors: { ...this.channelErrors },
      lastCallTime: this.lastCallTime,
      lastCheckTime: this.lastCheckTime,
      isPhoneAuthPending: !!this.phoneCodeHash,
      phone: this.phone,
      isAuthenticated: this.isAuthenticated,
      userName: this.authenticatedUser,
      phoneCodeSent: !!this.phoneCodeHash,
      statusMessage: this.isAuthenticated
        ? `Compte Telegram connecté (@${this.authenticatedUser || this.phone}) & écoute active`
        : this.isRunning
        ? `Écoute continue de ${channelList.join(' & ')}`
        : 'Listener inactif',
    };
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.botLaunchTime = Date.now();
    this.isInitialScan = true;
    console.log(`[TelegramListener] Starting real-time listener at ${new Date(this.botLaunchTime).toLocaleTimeString()} for channels: ${this.channels.join(', ')}...`);

    // Initial seed: fetch existing posts from channels, seed feed, mark as historical (NEVER auto-snipe old calls)
    try {
      console.log('[TelegramListener] Seeding pre-existing historical posts (auto-snipe disabled for past calls)...');
      await this.fetchAllChannels(true);
    } catch (err) {
      console.error('[TelegramListener] Initial channel seed error:', err);
    } finally {
      this.isInitialScan = false;
      console.log(`[TelegramListener] ✓ Initial seed completed. ONLY calls newly arriving after ${new Date(this.botLaunchTime).toLocaleTimeString()} will be auto-sniped.`);
    }

    // Start 3.5-second continuous real-time channel poll for new incoming messages
    this.pollInterval = setInterval(async () => {
      try {
        await this.fetchAllChannels(false);
      } catch (err) {
        console.error('[TelegramListener] Polling cycle error:', err);
      }
    }, 3500);

    // Initialize GramJS client in background if possible
    this.ensureGramClientConnected().catch((err) => {
      console.warn('[TelegramListener] GramJS background init note:', err?.message || err);
    });
  }

  public stop(): void {
    this.isRunning = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    console.log('[TelegramListener] Listener stopped');
  }

  public async requestPhoneCode(customPhone?: string): Promise<{ success: boolean; phoneCodeHash?: string; message: string }> {
    if (customPhone && customPhone.trim()) {
      this.phone = customPhone.trim();
    }
    if (!this.phone || this.phone.length < 5) {
      return {
        success: false,
        message: 'Veuillez saisir un numéro de téléphone international valide (ex: +242068658897)',
      };
    }

    try {
      const { TelegramClient } = await import('telegram');
      const { StringSession } = await import('telegram/sessions');

      const session = new StringSession('');
      this.gramClient = new TelegramClient(session, this.apiId, this.apiHash, {
        connectionRetries: 3,
      });

      await this.gramClient.connect();
      const res = await this.gramClient.sendCode(
        {
          apiId: this.apiId,
          apiHash: this.apiHash,
        },
        this.phone
      );

      this.phoneCodeHash = res.phoneCodeHash;
      console.log(`[TelegramListener] Verification code dispatched to ${this.phone}`);
      return {
        success: true,
        phoneCodeHash: res.phoneCodeHash,
        message: `Code de vérification envoyé avec succès par Telegram / SMS au ${this.phone}`,
      };
    } catch (err: any) {
      console.error('[TelegramListener] sendCode error:', err);
      return {
        success: false,
        message: err.message || 'Échec de l\'envoi du code de vérification',
      };
    }
  }

  public async submitVerificationCode(code: string, password?: string): Promise<{ success: boolean; message: string; requiresPassword?: boolean }> {
    if (!this.gramClient || !this.phoneCodeHash) {
      return { success: false, message: 'Aucune demande de code en attente. Veuillez d\'abord cliquer sur Envoyer le code.' };
    }
    const cleanCode = code.trim();
    if (!cleanCode) {
      return { success: false, message: 'Le code de vérification Telegram ne peut pas être vide' };
    }

    try {
      const { Api } = await import('telegram');

      let user: any = null;
      try {
        const result = await this.gramClient.invoke(
          new Api.auth.SignIn({
            phoneNumber: this.phone,
            phoneCodeHash: this.phoneCodeHash,
            phoneCode: cleanCode,
          })
        );
        user = (result as any)?.user;
      } catch (signInErr: any) {
        const errMsg = (signInErr?.errorMessage || signInErr?.message || '').toString();
        if (
          errMsg.includes('SESSION_PASSWORD_NEEDED') ||
          signInErr?.errorMessage === 'SESSION_PASSWORD_NEEDED'
        ) {
          if (password && password.trim()) {
            const { computeCheck } = await import('telegram/Password.js');
            const passwordSrpResult = await this.gramClient.invoke(new Api.account.GetPassword());
            const passwordSrpCheck = await computeCheck(passwordSrpResult, password.trim());
            const checkResult = await this.gramClient.invoke(
              new Api.auth.CheckPassword({
                password: passwordSrpCheck,
              })
            );
            user = (checkResult as any)?.user;
          } else {
            return {
              success: false,
              requiresPassword: true,
              message: 'Vérification 2FA requise : veuillez renseigner votre mot de passe Telegram cloud (2FA).',
            };
          }
        } else {
          throw signInErr;
        }
      }

      this.isAuthenticated = true;
      this.authenticatedUser = user?.username || user?.firstName || this.phone;
      this.phoneCodeHash = undefined;
      console.log('[TelegramListener] GramJS authenticated successfully!', this.authenticatedUser);

      try {
        const sessionString = this.gramClient.session.save();
        this.saveTelegramAuthToDisk(sessionString);
      } catch (e) {
        console.warn('[TelegramListener] Error saving session string:', e);
      }

      return {
        success: true,
        message: `Compte Telegram connecté avec succès ! (Utilisateur: ${this.authenticatedUser})`,
      };
    } catch (err: any) {
      console.error('[TelegramListener] signIn error:', err);
      const msg = (err?.errorMessage || err?.message || '').toString();
      if (msg.includes('PHONE_CODE_INVALID')) {
        return {
          success: false,
          message: 'Code de vérification invalide. Veuillez vérifier le code à 5 chiffres reçu sur Telegram.',
        };
      }
      if (msg.includes('PHONE_CODE_EXPIRED')) {
        return {
          success: false,
          message: 'Le code a expiré. Veuillez cliquer à nouveau sur "Envoyer le Code".',
        };
      }
      if (msg.includes('PASSWORD_HASH_INVALID')) {
        return {
          success: false,
          requiresPassword: true,
          message: 'Mot de passe 2FA incorrect. Veuillez vérifier votre mot de passe cloud Telegram.',
        };
      }
      if (msg.includes('SESSION_PASSWORD_NEEDED')) {
        return {
          success: false,
          requiresPassword: true,
          message: 'Vérification 2FA requise : veuillez renseigner votre mot de passe Telegram cloud (2FA).',
        };
      }
      return {
        success: false,
        message: err.message || 'Code de vérification invalide ou expiré',
      };
    }
  }

  public disconnectTelegram(): { success: boolean; message: string } {
    this.isAuthenticated = false;
    this.authenticatedUser = undefined;
    this.phoneCodeHash = undefined;
    try {
      if (fs.existsSync(TG_DATA_FILE)) {
        fs.unlinkSync(TG_DATA_FILE);
      }
    } catch (err) {
      console.warn('[TelegramListener] Error removing telegram session file:', err);
    }
    return { success: true, message: 'Compte Telegram déconnecté' };
  }

  private async ensureGramClientConnected(): Promise<boolean> {
    if (this.gramClient) return true;
    try {
      let savedSession = '';
      if (fs.existsSync(TG_DATA_FILE)) {
        const raw = fs.readFileSync(TG_DATA_FILE, 'utf-8');
        const data = JSON.parse(raw);
        savedSession = data.sessionString || '';
      }
      if (!savedSession && process.env.TELEGRAM_SESSION_STRING) {
        savedSession = process.env.TELEGRAM_SESSION_STRING;
      }
      const { TelegramClient } = await import('telegram');
      const { StringSession } = await import('telegram/sessions/index.js');
      const session = new StringSession(savedSession);
      this.gramClient = new TelegramClient(session, this.apiId, this.apiHash, {
        connectionRetries: 3,
      });
      await this.gramClient.connect();
      return true;
    } catch (err) {
      console.warn('[TelegramListener] Could not reconnect GramJS client:', err);
      return false;
    }
  }

  private async fetchAllChannels(isInitial: boolean = false): Promise<void> {
    this.lastCheckTime = Date.now();
    await Promise.allSettled(
      this.channels.map(async (ch) => {
        const clean = this.cleanChannelName(ch);
        if (!clean || this.invalidChannels.has(clean.toLowerCase())) {
          return;
        }
        if (this.isAuthenticated) {
          await this.ensureGramClientConnected();
          if (this.gramClient) {
            try {
              await this.fetchChannelWithGramClient(clean, isInitial);
              return;
            } catch {
              // Fallback or error handled inside
            }
          }
        }
        await this.fetchChannelPostsFor(clean, isInitial);
      })
    );
  }

  private async fetchChannelWithGramClient(channel: string, isInitial: boolean = false): Promise<void> {
    if (!this.gramClient || !this.isAuthenticated) return;
    try {
      const messages = await this.gramClient.getMessages(channel, { limit: 15 });
      if (!messages || !Array.isArray(messages)) return;

      for (const msg of messages) {
        if (!msg || !msg.message) continue;
        const postSlug = `${channel}/${msg.id}`;
        if (this.processedPostIds.has(postSlug)) continue;
        this.processedPostIds.add(postSlug);
        this.saveProcessedPostsToDisk();

        const cleanText = msg.message;
        const tokenAddress = this.extractSolanaAddress(cleanText, '');
        if (!tokenAddress) continue;

        // Calculate actual post timestamp
        const messageTimestamp = msg.date ? msg.date * 1000 : Date.now();
        const messageAgeMs = Math.max(0, Date.now() - messageTimestamp);

        // Strict guard: Call is historical if:
        // 1. We are in the initial boot scan
        // 2. The post date was prior to bot start time (minus 30s network grace)
        // 3. The message is older than 2 minutes (120,000 ms)
        const isHistorical = isInitial || this.isInitialScan || messageTimestamp < (this.botLaunchTime - 30_000) || messageAgeMs > 120_000;
        const canAutoSnipe = !isHistorical;

        const channelSlug = `t.me/${channel}`;
        this.totalAlertsReceived++;
        this.channelStats[channelSlug] = (this.channelStats[channelSlug] || 0) + 1;
        if (this.channelErrors[channelSlug]) {
          delete this.channelErrors[channelSlug];
        }

        let symbol: string | undefined;
        const symbolMatch = cleanText.match(/Token:\s*\$?([A-Za-z0-9_]{2,14})/i);
        if (symbolMatch) {
          symbol = symbolMatch[1].toUpperCase();
        } else {
          const parenMatch = cleanText.match(/\(([A-Za-z0-9_]{2,14})\)/);
          if (parenMatch) {
            symbol = parenMatch[1].toUpperCase();
          } else {
            const dollarMatch = cleanText.match(/\$([A-Za-z0-9_]{2,14})/);
            if (dollarMatch) {
              symbol = dollarMatch[1].toUpperCase();
            }
          }
        }

        const existingCall = this.calls.find(
          (c) => c.tokenAddress.toLowerCase() === tokenAddress.toLowerCase()
        );

        if (existingCall) {
          this.totalDuplicatesFiltered++;
          if (!existingCall.channels) existingCall.channels = [existingCall.channel];
          if (!existingCall.channels.includes(channelSlug)) {
            existingCall.channels.push(channelSlug);
          }
          existingCall.callCount = (existingCall.callCount || 1) + 1;
          existingCall.lastAlertTime = messageTimestamp;
          if ((!existingCall.tokenSymbol || existingCall.tokenSymbol === 'UNKNOWN') && symbol) {
            existingCall.tokenSymbol = symbol;
          }
          if (this.onCallUpdated) this.onCallUpdated(existingCall);
          continue;
        }

        const mcMatch = cleanText.match(/MC\s*[≡:=]\s*([^\n|]+)/i);
        const claimedMarketCap = mcMatch ? mcMatch[1].replace(/\$/g, '').trim() : undefined;
        const ageMatch = cleanText.match(/(?:Age\s*[≡:=]|⌛️)\s*([0-9]+[smhd])/i);
        const claimedAge = ageMatch ? ageMatch[1].trim() : undefined;

        const callItem: TelegramCall = {
          id: `call_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          messageId: postSlug,
          channel: channelSlug,
          channels: [channelSlug],
          callCount: 1,
          lastAlertTime: messageTimestamp,
          timestamp: messageTimestamp,
          rawText: cleanText,
          tokenAddress,
          tokenSymbol: symbol,
          claimedMarketCap: claimedMarketCap ? `$${claimedMarketCap}` : undefined,
          claimedAge,
          status: isHistorical ? 'PENDING' : 'ANALYZING',
          isHistorical,
          canAutoSnipe,
        };

        this.calls.unshift(callItem);
        if (this.calls.length > 150) this.calls.pop();
        this.lastCallTime = Date.now();
        console.log(`[TelegramListener][${channel}][MTProto] ${isHistorical ? 'HISTORICAL CALL ARCHIVED' : 'LIVE NEW CALL DETECTED'}: ${tokenAddress} (${symbol || 'UNKNOWN'}) [AutoSnipe: ${canAutoSnipe}]`);
        this.onCall(callItem);
      }
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      const isEntityNotFound =
        /USERNAME_INVALID|No user has|Cannot find any entity|USERNAME_NOT_OCCUPIED|CHANNEL_INVALID|CHAT_ADMIN_REQUIRED|CHANNEL_PRIVATE/i.test(
          errMsg
        );

      if (isEntityNotFound) {
        const slug = `t.me/${channel}`;
        this.channelErrors[slug] = `Canal introuvable ou inaccessible (@${channel})`;
        this.invalidChannels.add(channel.toLowerCase());
        console.log(`[TelegramListener] Notice: Channel @${channel} is inaccessible on Telegram (${errMsg.slice(0, 60)})`);
        return;
      }

      console.warn(`[TelegramListener] Warning fetching messages for ${channel} via GramJS:`, errMsg);
      await this.fetchChannelPostsFor(channel, isInitial);
    }
  }

  /**
   * Scrapes the official Telegram web preview feed (t.me/s/CHANNEL)
   * which provides 100% real-time posts without authentication requirements.
   */
  private async fetchChannelPostsFor(channel: string, isInitial: boolean = false): Promise<void> {
    if (this.invalidChannels.has(channel.toLowerCase())) return;

    const url = `https://t.me/s/${channel}`;

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
      });

      if (!response.ok) {
        if (response.status === 404 || response.status === 302) {
          const slug = `t.me/${channel}`;
          this.channelErrors[slug] = `Canal introuvable ou privé (HTTP ${response.status})`;
          this.invalidChannels.add(channel.toLowerCase());
        }
        return;
      }

      const slug = `t.me/${channel}`;
      if (this.channelErrors[slug]) {
        delete this.channelErrors[slug];
      }

      const html = await response.text();
      this.parseTelegramHtml(html, channel, isInitial);
    } catch {
      // Ignored for transient network blips
    }
  }

  private parseTelegramHtml(html: string, channel: string, isInitial: boolean = false): void {
    // Each Telegram message widget has data-post="CHANNEL/MESSAGE_ID"
    const messageRegex = /<div class="tgme_widget_message\s+[^"]*"\s+data-post="([^"]+)"[\s\S]*?<div class="tgme_widget_message_text\s+[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
    let match;

    while ((match = messageRegex.exec(html)) !== null) {
      const postSlug = match[1]; // e.g. pumpdotfunalert/515838 or SolanaWhalePumps/38339
      const rawTextHtml = match[2];

      if (this.processedPostIds.has(postSlug)) {
        continue;
      }
      this.processedPostIds.add(postSlug);
      this.saveProcessedPostsToDisk();

      // Clean plain text & HTML entities first for accurate pattern matching
      const cleanText = rawTextHtml
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&#036;/g, '$')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();

      // Extract Solana token contract address
      const tokenAddress = this.extractSolanaAddress(cleanText, rawTextHtml);
      if (!tokenAddress) {
        continue;
      }

      // Extract publication timestamp from <time datetime="..."> in the message widget header
      let messageTimestamp = Date.now();
      const timeMatch = match[0].match(/<time\s+[^>]*datetime="([^"]+)"/i);
      if (timeMatch && timeMatch[1]) {
        const parsed = new Date(timeMatch[1]).getTime();
        if (!isNaN(parsed) && parsed > 0) {
          messageTimestamp = parsed;
        }
      }

      const messageAgeMs = Math.max(0, Date.now() - messageTimestamp);
      // Strictly prevent old calls from ever triggering auto-snipe:
      // 1. Initial boot scan
      // 2. Message was posted before bot launch time (minus 30s network grace)
      // 3. Message is older than 2 minutes (120 seconds)
      const isHistorical = isInitial || this.isInitialScan || messageTimestamp < (this.botLaunchTime - 30_000) || messageAgeMs > 120_000;
      const canAutoSnipe = !isHistorical;

      const channelSlug = `t.me/${channel}`;
      this.totalAlertsReceived++;
      this.channelStats[channelSlug] = (this.channelStats[channelSlug] || 0) + 1;

      // Extract token symbol:
      // Pattern 1: Token: $XYZ or Token: XYZ
      // Pattern 2: Name (SYMBOL) NEW ALERT (pumpdotfunalert format)
      // Pattern 3: $SYMBOL
      let symbol: string | undefined;

      const symbolMatch = cleanText.match(/Token:\s*\$?([A-Za-z0-9_]{2,14})/i);
      if (symbolMatch) {
        symbol = symbolMatch[1].toUpperCase();
      } else {
        const parenMatch = cleanText.match(/\(([A-Za-z0-9_]{2,14})\)/);
        if (parenMatch) {
          symbol = parenMatch[1].toUpperCase();
        } else {
          const dollarMatch = cleanText.match(/\$([A-Za-z0-9_]{2,14})/);
          if (dollarMatch) {
            symbol = dollarMatch[1].toUpperCase();
          }
        }
      }

      // Check if this token address has already been detected (DEDUPLICATION)
      const existingCall = this.calls.find(
        (c) => c.tokenAddress.toLowerCase() === tokenAddress.toLowerCase()
      );

      if (existingCall) {
        this.totalDuplicatesFiltered++;

        // Ensure channels list contains this channel
        if (!existingCall.channels) {
          existingCall.channels = [existingCall.channel];
        }
        if (!existingCall.channels.includes(channelSlug)) {
          existingCall.channels.push(channelSlug);
          console.log(
            `[TelegramListener] Dual-channel alert! ${existingCall.tokenSymbol || tokenAddress.slice(0, 8)} detected in BOTH ${existingCall.channels.join(' & ')}`
          );
        }

        existingCall.callCount = (existingCall.callCount || 1) + 1;
        existingCall.lastAlertTime = messageTimestamp;
        if ((!existingCall.tokenSymbol || existingCall.tokenSymbol === 'UNKNOWN') && symbol) {
          existingCall.tokenSymbol = symbol;
        }

        // Broadcast update to front-end so channels badges & alert count stay up-to-date
        if (this.onCallUpdated) {
          this.onCallUpdated(existingCall);
        }

        // Stop here: eliminate duplicate snipe & duplicate GMGN analysis
        continue;
      }

      // Extract MC claim, e.g. MC ≡ $91k or MC: $35.2K
      const mcMatch = cleanText.match(/MC\s*[≡:=]\s*([^\n|]+)/i);
      const claimedMarketCap = mcMatch ? mcMatch[1].replace(/\$/g, '').trim() : undefined;

      // Extract Age claim, e.g. Age ≡ 5m or ⌛️ 14m
      const ageMatch = cleanText.match(/(?:Age\s*[≡:=]|⌛️)\s*([0-9]+[smhd])/i);
      const claimedAge = ageMatch ? ageMatch[1].trim() : undefined;

      const callItem: TelegramCall = {
        id: `call_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        messageId: postSlug,
        channel: channelSlug,
        channels: [channelSlug],
        callCount: 1,
        lastAlertTime: messageTimestamp,
        timestamp: messageTimestamp,
        rawText: cleanText,
        tokenAddress,
        tokenSymbol: symbol,
        claimedMarketCap: claimedMarketCap ? `$${claimedMarketCap}` : undefined,
        claimedAge,
        status: isHistorical ? 'PENDING' : 'ANALYZING',
        isHistorical,
        canAutoSnipe,
      };

      this.calls.unshift(callItem);
      // Keep max 150 in memory
      if (this.calls.length > 150) {
        this.calls.pop();
      }

      this.lastCallTime = Date.now();
      console.log(`[TelegramListener][${channel}] ${isHistorical ? 'HISTORICAL CALL ARCHIVED' : 'LIVE NEW CALL DETECTED'}: ${tokenAddress} (${symbol || 'UNKNOWN'}) [AutoSnipe: ${canAutoSnipe}]`);

      // Invoke callback for GMGN analysis and potential auto-snipe
      this.onCall(callItem);
    }
  }

  private extractSolanaAddress(cleanText: string, rawHtml: string): string | null {
    // 1. Look for explicit CA inside <code> tags
    const codeMatch = rawHtml.match(/<code>\s*([1-9A-HJ-NP-Za-km-z]{32,44})\s*<\/code>/);
    if (codeMatch) return codeMatch[1];

    // 2. Look for explicit "CA:" prefix
    const caPrefixMatch = cleanText.match(/CA:?\s*([1-9A-HJ-NP-Za-km-z]{32,44})/i);
    if (caPrefixMatch) return caPrefixMatch[1];

    // 3. Look for pump.fun specific addresses ending in pump
    const pumpMatch = cleanText.match(/\b([1-9A-HJ-NP-Za-km-z]{32,40}pump)\b/i);
    if (pumpMatch) return pumpMatch[1];

    // 4. Look for links with token address (solscan, rugcheck, gmgn, axiom, photon, dexscreener)
    const urlMatch = cleanText.match(/(?:token\/|tokens\/|solana\/|t\/)([1-9A-HJ-NP-Za-km-z]{32,44})/i);
    if (urlMatch) return urlMatch[1];

    // 5. Any 43-44 character base58 string
    const base58Match = cleanText.match(/\b([1-9A-HJ-NP-Za-km-z]{43,44})\b/);
    if (base58Match) return base58Match[1];

    return null;
  }

  public addManualCall(tokenAddress: string, symbol?: string): TelegramCall {
    const existing = this.calls.find(
      (c) => c.tokenAddress.toLowerCase() === tokenAddress.toLowerCase()
    );
    if (existing) {
      if (symbol && (!existing.tokenSymbol || existing.tokenSymbol === 'UNKNOWN')) {
        existing.tokenSymbol = symbol;
      }
      return existing;
    }
    const channelSlug = `t.me/${this.channels[0] || 'pumpdotfunalert'}`;
    const callItem: TelegramCall = {
      id: `manual_${Date.now()}`,
      messageId: `manual_${Date.now()}`,
      channel: channelSlug,
      channels: [channelSlug],
      callCount: 1,
      lastAlertTime: Date.now(),
      timestamp: Date.now(),
      rawText: `Manual trigger for token: ${tokenAddress}`,
      tokenAddress,
      tokenSymbol: symbol,
      status: 'ANALYZING',
    };
    this.calls.unshift(callItem);
    return callItem;
  }
}
