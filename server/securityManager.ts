import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const DATA_DIR = path.join(process.cwd(), 'server', 'data');
const SECURITY_FILE = path.join(DATA_DIR, 'security-config.json');

export interface SecurityConfig {
  enabled: boolean;
  codeHash?: string;
  salt?: string;
  autoLockMinutes: number; // 0 = session only (on tab close/refresh unless remembered), 15, 30, 60, etc.
  savedAt: number;
}

export interface SecurityStatus {
  enabled: boolean;
  hasCodeSet: boolean;
  autoLockMinutes: number;
}

export class SecurityManager {
  private config: SecurityConfig = {
    enabled: false,
    autoLockMinutes: 0,
    savedAt: Date.now(),
  };

  private activeTokens = new Set<string>();
  private failedAttempts = 0;
  private lockedUntil = 0;

  constructor() {
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      if (fs.existsSync(SECURITY_FILE)) {
        const raw = fs.readFileSync(SECURITY_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          this.config = {
            enabled: Boolean(parsed.enabled),
            codeHash: parsed.codeHash || undefined,
            salt: parsed.salt || undefined,
            autoLockMinutes: typeof parsed.autoLockMinutes === 'number' ? parsed.autoLockMinutes : 0,
            savedAt: parsed.savedAt || Date.now(),
          };
          console.log(`[SecurityManager] Loaded security config. Code set: ${Boolean(this.config.codeHash)}, Enabled: ${this.config.enabled}`);
        }
      }
    } catch (err) {
      console.warn('[SecurityManager] Could not load security config:', err);
    }
  }

  private saveToDisk(): void {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      this.config.savedAt = Date.now();
      fs.writeFileSync(SECURITY_FILE, JSON.stringify(this.config, null, 2), 'utf-8');
    } catch (err) {
      console.error('[SecurityManager] Failed to save security config:', err);
    }
  }

  private hashWithSalt(code: string, salt: string): string {
    return crypto.createHmac('sha256', salt).update(code.trim()).digest('hex');
  }

  public getStatus(): SecurityStatus {
    return {
      enabled: Boolean(this.config.enabled && this.config.codeHash),
      hasCodeSet: Boolean(this.config.codeHash),
      autoLockMinutes: this.config.autoLockMinutes,
    };
  }

  public generateSessionToken(): string {
    const token = crypto.randomBytes(32).toString('hex');
    this.activeTokens.add(token);
    // Keep set bounded to last 200 tokens
    if (this.activeTokens.size > 200) {
      const arr = Array.from(this.activeTokens);
      this.activeTokens = new Set(arr.slice(-100));
    }
    return token;
  }

  public isTokenValid(token?: string): boolean {
    if (!this.config.enabled || !this.config.codeHash) {
      return true; // No code protection enabled
    }
    if (!token) return false;
    return this.activeTokens.has(token);
  }

  public verifyCode(code: string): { success: boolean; token?: string; message: string; remainingAttempts?: number } {
    if (!this.config.codeHash || !this.config.salt) {
      // No code required
      const token = this.generateSessionToken();
      return { success: true, token, message: 'Aucun code configuré' };
    }

    const now = Date.now();
    if (this.lockedUntil > now) {
      const waitSeconds = Math.ceil((this.lockedUntil - now) / 1000);
      return {
        success: false,
        message: `Trop de tentatives erronées. Veuillez patienter ${waitSeconds} seconde(s) avant de réessayer.`,
      };
    }

    const cleanCode = (code || '').trim();
    if (!cleanCode) {
      return { success: false, message: 'Veuillez renseigner votre code de connexion' };
    }

    const checkHash = this.hashWithSalt(cleanCode, this.config.salt);
    if (checkHash === this.config.codeHash) {
      this.failedAttempts = 0;
      this.lockedUntil = 0;
      const token = this.generateSessionToken();
      return { success: true, token, message: 'Code validé avec succès' };
    }

    this.failedAttempts += 1;
    if (this.failedAttempts >= 5) {
      this.lockedUntil = now + 30000; // 30-sec lockout
      this.failedAttempts = 0;
      return {
        success: false,
        message: '5 tentatives incorrectes. Dashboard temporairement verrouillé pendant 30 secondes.',
      };
    }

    const remaining = 5 - this.failedAttempts;
    return {
      success: false,
      message: `Code incorrect (${remaining} tentative${remaining > 1 ? 's' : ''} restante${remaining > 1 ? 's' : ''})`,
      remainingAttempts: remaining,
    };
  }

  public setupCode(params: {
    newCode: string;
    currentCode?: string;
    autoLockMinutes?: number;
  }): { success: boolean; token?: string; message: string } {
    const { newCode, currentCode, autoLockMinutes } = params;
    const cleanNew = (newCode || '').trim();

    if (cleanNew.length < 4) {
      return {
        success: false,
        message: 'Le code de connexion doit comporter au moins 4 caractères ou chiffres.',
      };
    }

    // If a code is already configured, verify current code first
    if (this.config.codeHash && this.config.salt) {
      const cleanCurrent = (currentCode || '').trim();
      if (!cleanCurrent) {
        return {
          success: false,
          message: 'Veuillez saisir le code actuel pour modifier votre code de connexion.',
        };
      }
      const currentHash = this.hashWithSalt(cleanCurrent, this.config.salt);
      if (currentHash !== this.config.codeHash) {
        return {
          success: false,
          message: 'Le code actuel saisi est incorrect.',
        };
      }
    }

    // Generate new salt and hash
    const salt = crypto.randomBytes(16).toString('hex');
    const codeHash = this.hashWithSalt(cleanNew, salt);

    this.config.salt = salt;
    this.config.codeHash = codeHash;
    this.config.enabled = true;
    if (typeof autoLockMinutes === 'number') {
      this.config.autoLockMinutes = autoLockMinutes;
    }

    this.saveToDisk();

    const token = this.generateSessionToken();
    console.log('[SecurityManager] ✓ Code de connexion configuré avec succès !');

    return {
      success: true,
      token,
      message: 'Code de connexion configuré et activé avec succès pour le dashboard !',
    };
  }

  public toggleProtection(enabled: boolean, currentCode: string): { success: boolean; message: string } {
    if (!this.config.codeHash || !this.config.salt) {
      return {
        success: false,
        message: 'Aucun code configuré. Veuillez d\'abord définir un code de connexion.',
      };
    }

    const cleanCurrent = (currentCode || '').trim();
    if (!cleanCurrent) {
      return {
        success: false,
        message: 'Veuillez saisir votre code de connexion actuel pour valider cette action.',
      };
    }

    const currentHash = this.hashWithSalt(cleanCurrent, this.config.salt);
    if (currentHash !== this.config.codeHash) {
      return {
        success: false,
        message: 'Code actuel incorrect.',
      };
    }

    this.config.enabled = Boolean(enabled);
    this.saveToDisk();

    return {
      success: true,
      message: enabled
        ? 'Protection par code activée pour le dashboard streaming.'
        : 'Protection par code désactivée.',
    };
  }

  public removeCode(currentCode: string): { success: boolean; message: string } {
    if (!this.config.codeHash || !this.config.salt) {
      return { success: true, message: 'Aucun code n\'était configuré.' };
    }

    const cleanCurrent = (currentCode || '').trim();
    const currentHash = this.hashWithSalt(cleanCurrent, this.config.salt);
    if (currentHash !== this.config.codeHash) {
      return {
        success: false,
        message: 'Code actuel incorrect. Impossible de supprimer le code.',
      };
    }

    this.config.codeHash = undefined;
    this.config.salt = undefined;
    this.config.enabled = false;
    this.activeTokens.clear();
    this.saveToDisk();

    return {
      success: true,
      message: 'Code de connexion supprimé avec succès.',
    };
  }

  public updateAutoLock(autoLockMinutes: number): { success: boolean; message: string } {
    this.config.autoLockMinutes = autoLockMinutes;
    this.saveToDisk();
    return {
      success: true,
      message: `Délai de verrouillage automatique mis à jour : ${autoLockMinutes === 0 ? 'À la fermeture du navigateur' : `${autoLockMinutes} minutes`}.`,
    };
  }
}
