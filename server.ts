import dotenv from 'dotenv';
dotenv.config();

// Gracefully handle internal GramJS socket disconnect events without crashing or false-alerting
process.on('unhandledRejection', (reason: any) => {
  const msg = reason?.message || String(reason || '');
  if (msg.includes('Not connected')) {
    return;
  }
  console.warn('[Server] Unhandled rejection:', reason);
});

process.on('uncaughtException', (err: any) => {
  const msg = err?.message || String(err || '');
  if (msg.includes('Not connected')) {
    return;
  }
  console.error('[Server] Uncaught exception:', err);
});

import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { DexscreenerClient } from './server/dexscreener';
import { GMGNAnalyzer } from './server/gmgnAnalyzer';
import { SniperEngine } from './server/sniperEngine';
import { TelegramListener } from './server/telegramListener';
import { SecurityManager } from './server/securityManager';

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Connected SSE clients
  const sseClients: express.Response[] = [];

  const broadcast = (event: { type: string; data: any }) => {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (let i = sseClients.length - 1; i >= 0; i--) {
      try {
        sseClients[i].write(payload);
      } catch {
        sseClients.splice(i, 1);
      }
    }
  };

  // Instantiate core services
  const dexscreener = new DexscreenerClient();
  const gmgnAnalyzer = new GMGNAnalyzer();
  const sniperEngine = new SniperEngine(dexscreener);
  const securityManager = new SecurityManager();

  sniperEngine.setCallbacks(
    (positions) => broadcast({ type: 'POSITIONS_UPDATED', data: positions }),
    (trade) => broadcast({ type: 'TRADE_EXECUTED', data: trade })
  );

  const telegramListener = new TelegramListener({
    channels: ['pumpdotfunalert'],
    apiId: Number(process.env.TELEGRAM_API_ID || 33801866),
    apiHash: process.env.TELEGRAM_API_HASH || '6139880385749ef5b9aee207dc41f887',
    phone: process.env.TELEGRAM_PHONE || '+242068658897',
    onCallUpdated: (call) => {
      broadcast({ type: 'CALL_UPDATED', data: call });
    },
    onCall: async (call) => {
      broadcast({ type: 'CALL_DETECTED', data: call });

      // Run GMGN & multi-source deep on-chain analysis with rich alert context
      try {
        const report = await gmgnAnalyzer.analyzeToken(call.tokenAddress, {
          rawText: call.rawText,
          claimedMarketCap: call.claimedMarketCap,
          claimedAge: call.claimedAge,
          symbol: call.tokenSymbol,
          tokenName: call.tokenName,
          channel: call.channel,
        });
        call.analysis = report;
        call.status = report.decision;
        if (report.rugCheck) {
          call.rugCheck = report.rugCheck;
        }
        if (!call.tokenSymbol && report.tokenSymbol) {
          call.tokenSymbol = report.tokenSymbol;
        }
        broadcast({ type: 'CALL_ANALYZED', data: call });

        // GUARD: Strictly prevent auto-sniping historical calls or calls older than 2 minutes
        const callAgeSeconds = Math.max(0, Math.round((Date.now() - call.timestamp) / 1000));
        if (call.isHistorical || !call.canAutoSnipe || callAgeSeconds > 120) {
          console.log(
            `[Server] 🛡️ AUTO-SNIPE PREVENTED: Call for ${call.tokenSymbol || call.tokenAddress.slice(0, 8)} is historical/archive (${callAgeSeconds}s old, isHistorical: ${!!call.isHistorical}, canAutoSnipe: ${!!call.canAutoSnipe}). Displayed in feed only.`
          );
          return;
        }

        // If all 7 conditions passed and auto-snipe is enabled, execute snipe ONLY for fresh live calls!
        if (report.decision === 'SNIPED' && sniperEngine.getConfig().autoSnipe) {
          console.log(`[Server] ⚡ AUTO-SNIPING LIVE NEW CALL: ${report.tokenSymbol} (${call.tokenAddress})`);
          const pos = await sniperEngine.executeSnipe(report);
          broadcast({ type: 'SNIPE_EXECUTED', data: pos });
        } else {
          const passedCount = report.conditions ? report.conditions.filter((c) => c.passed).length : 0;
          console.log(`[Server] Token evaluation for ${report.tokenSymbol || call.tokenAddress.slice(0, 8)}: ${passedCount}/7 criteria matched (${report.decision})`);
        }
      } catch (err: any) {
        console.error('[Server] GMGN Analysis error on call:', err);
        call.status = 'REJECTED';
        call.error = err.message || 'GMGN Analysis failed';
        broadcast({ type: 'CALL_ANALYZED', data: call });
      }
    },
  });

  // Start continuous Telegram listener
  telegramListener.start().catch((err) => {
    console.error('[Server] Failed to start Telegram listener:', err);
  });

  // ================= API ENDPOINTS =================

  // Real-time SSE stream for front-end
  app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    sseClients.push(res);
    res.write(`data: ${JSON.stringify({ type: 'CONNECTED', timestamp: Date.now() })}\n\n`);

    const keepAliveInterval = setInterval(() => {
      try {
        res.write(': heartbeat\n\n');
      } catch {
        clearInterval(keepAliveInterval);
      }
    }, 15000);

    req.on('close', () => {
      clearInterval(keepAliveInterval);
      const idx = sseClients.indexOf(res);
      if (idx !== -1) sseClients.splice(idx, 1);
    });
  });

  // System status
  app.get('/api/status', (req, res) => {
    res.json({
      status: 'operational',
      telegram: telegramListener.getStatus(),
      sniperConfig: sniperEngine.getConfig(),
      activePositionsCount: sniperEngine.getActivePositions().length,
      tradeHistoryCount: sniperEngine.getTradeHistory().length,
      gmgnApiKeyConfigured: !!process.env.GMGN_API_KEY,
      security: securityManager.getStatus(),
    });
  });

  // Telegram calls history
  app.get('/api/calls', (req, res) => {
    res.json({
      calls: telegramListener.getCalls(),
      status: telegramListener.getStatus(),
    });
  });

  // Active positions
  app.get('/api/positions', (req, res) => {
    res.json({
      positions: sniperEngine.getActivePositions(),
    });
  });

  // Force on-demand price refresh for all active positions
  app.post('/api/positions/refresh', async (req, res) => {
    try {
      const refreshed = await sniperEngine.refreshPricesNow();
      res.json({
        success: true,
        positions: refreshed,
        refreshedAt: Date.now(),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to refresh prices' });
    }
  });

  // Trade history
  app.get('/api/history', (req, res) => {
    res.json({
      history: sniperEngine.getTradeHistory(),
    });
  });

  // Sniping & Trading Performance Stats (30-day default with daily resolution)
  app.get('/api/stats', (req, res) => {
    const days = parseInt(req.query.days as string, 10) || 30;
    const stats = sniperEngine.getPerformanceStats(days);
    res.json(stats);
  });

  // Sniper config GET & POST
  app.get('/api/config', (req, res) => {
    res.json(sniperEngine.getConfig());
  });

  app.post('/api/config', (req, res) => {
    const updated = sniperEngine.updateConfig(req.body);
    broadcast({ type: 'CONFIG_UPDATED', data: updated });
    res.json(updated);
  });

  // Manual Token Analysis with Multi-Source Consensus (Dexscreener, RugCheck, GMGN)
  app.post('/api/manual-analyze', async (req, res) => {
    const { tokenAddress } = req.body;
    if (!tokenAddress || typeof tokenAddress !== 'string') {
      return res.status(400).json({ error: 'Token address is required' });
    }

    try {
      const cleanAddr = tokenAddress.trim();
      const existingCall = telegramListener
        .getCalls()
        .find((c) => c.tokenAddress.toLowerCase() === cleanAddr.toLowerCase());

      const report = await gmgnAnalyzer.analyzeToken(cleanAddr, {
        rawText: existingCall?.rawText,
        claimedMarketCap: existingCall?.claimedMarketCap,
        claimedAge: existingCall?.claimedAge,
        symbol: existingCall?.tokenSymbol,
        tokenName: existingCall?.tokenName,
        channel: existingCall?.channel,
      });

      // Register or update call item for UI tracking
      const call = existingCall || telegramListener.addManualCall(cleanAddr, report.tokenSymbol);
      call.analysis = report;
      call.status = report.decision;
      if (report.rugCheck) {
        call.rugCheck = report.rugCheck;
      }
      if (!call.tokenSymbol && report.tokenSymbol) {
        call.tokenSymbol = report.tokenSymbol;
      }
      broadcast({ type: 'CALL_ANALYZED', data: call });

      // Return analysis without triggering automatic snipe (explicit snipe available via /api/manual-snipe)
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Analysis failed' });
    }
  });

  // Direct RugCheck query endpoint
  app.get('/api/tokens/:address/rugcheck', async (req, res) => {
    try {
      const { address } = req.params;
      const rugSummary = await gmgnAnalyzer.getRugCheckSummary(address);
      res.json(rugSummary);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'RugCheck query failed' });
    }
  });

  // Re-analyze a specific call by ID
  app.post('/api/calls/:id/analyze', async (req, res) => {
    const { id } = req.params;
    const calls = telegramListener.getCalls();
    const call = calls.find((c) => c.id === id);
    if (!call) {
      return res.status(404).json({ error: 'Call introuvable' });
    }

    try {
      call.status = 'ANALYZING';
      broadcast({ type: 'CALL_UPDATED', data: call });

      const report = await gmgnAnalyzer.analyzeToken(call.tokenAddress, {
        rawText: call.rawText,
        claimedMarketCap: call.claimedMarketCap,
        claimedAge: call.claimedAge,
        symbol: call.tokenSymbol,
        tokenName: call.tokenName,
        channel: call.channel,
      });

      call.analysis = report;
      call.status = report.decision;
      if (report.rugCheck) {
        call.rugCheck = report.rugCheck;
      }
      if (!call.tokenSymbol && report.tokenSymbol) {
        call.tokenSymbol = report.tokenSymbol;
      }
      broadcast({ type: 'CALL_ANALYZED', data: call });
      res.json({ success: true, report, call });
    } catch (err: any) {
      call.status = 'REJECTED';
      call.error = err.message;
      broadcast({ type: 'CALL_ANALYZED', data: call });
      res.status(500).json({ error: err.message || 'Audit échoué' });
    }
  });

  // Manual Snipe execution
  app.post('/api/manual-snipe', async (req, res) => {
    const { tokenAddress, customAmountSol } = req.body;
    if (!tokenAddress) {
      return res.status(400).json({ error: 'Token address is required' });
    }

    try {
      const report = await gmgnAnalyzer.analyzeToken(tokenAddress.trim());
      const position = await sniperEngine.executeSnipe(report, customAmountSol);
      broadcast({ type: 'SNIPE_EXECUTED', data: position });
      res.json({ success: true, position });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Manual snipe failed' });
    }
  });

  // Close / Sell Position
  app.post('/api/sell-position', async (req, res) => {
    const { positionId, percent, reason } = req.body;
    if (!positionId) {
      return res.status(400).json({ error: 'Position ID is required' });
    }

    try {
      const trade = await sniperEngine.sellPosition(positionId, percent || 100, reason || 'Manual User Sell');
      if (!trade) {
        // Broadcast current fresh positions so UI resyncs immediately
        broadcast({ type: 'POSITIONS_UPDATED', data: sniperEngine.getActivePositions() });
        return res.json({
          success: true,
          closed: true,
          message: 'Position was already closed or settled on-chain',
          positionId,
        });
      }
      res.json({ success: true, trade });
    } catch (err: any) {
      console.error('[Server] Sell order error:', err);
      res.status(500).json({ error: err.message || 'Failed to execute sell order' });
    }
  });

  // Update TP, SL, Trailing Stop, Stagnation Auto-Sell on an active position
  app.post('/api/position/update-targets', (req, res) => {
    const { positionId, tpPercent, slPercent, trailingStopPercent, autoSellStagnant, stagnantTimeoutSeconds } = req.body;
    if (!positionId) {
      return res.status(400).json({ error: 'Position ID is required' });
    }

    const updated = sniperEngine.updatePositionTargets(positionId, {
      tpPercent: tpPercent !== undefined ? Number(tpPercent) : undefined,
      slPercent: slPercent !== undefined ? Number(slPercent) : undefined,
      trailingStopPercent: trailingStopPercent !== undefined ? Number(trailingStopPercent) : undefined,
      autoSellStagnant: autoSellStagnant !== undefined ? Boolean(autoSellStagnant) : undefined,
      stagnantTimeoutSeconds: stagnantTimeoutSeconds !== undefined ? Number(stagnantTimeoutSeconds) : undefined,
    });

    if (!updated) {
      return res.status(404).json({ error: 'Position not found' });
    }

    broadcast({ type: 'POSITIONS_UPDATED', data: sniperEngine.getActivePositions() });
    res.json({ success: true, position: updated });
  });

  // Add Telegram channel(s) dynamically (supports single name, comma-separated string, or array)
  app.post('/api/telegram/add-channel', (req, res) => {
    const { channel, channels } = req.body;
    const target = channels || channel;
    if (!target) {
      return res.status(400).json({ success: false, message: 'Nom du canal requis (ex: pumpdotfunalert)' });
    }
    const result = telegramListener.addChannels(target);
    const status = telegramListener.getStatus();
    broadcast({ type: 'STATUS_UPDATED', data: status });
    let message = '';
    if (result.added.length > 0) {
      message = `${result.added.length} canal(aux) ajouté(s) : ${result.added.join(', ')}`;
    } else if (result.invalid.length > 0) {
      message = `Identifiant de canal invalide : ${result.invalid.join(', ')} (4 à 32 caractères requis)`;
    } else {
      message = 'Canal déjà enregistré dans la liste';
    }
    res.json({
      success: result.added.length > 0,
      added: result.added,
      ignored: result.ignored,
      invalid: result.invalid,
      message,
      status,
    });
  });

  // Remove Telegram channel(s) dynamically
  app.post('/api/telegram/remove-channel', (req, res) => {
    const { channel, channels, clearAll } = req.body;
    if (clearAll) {
      telegramListener.clearAllChannels();
      const status = telegramListener.getStatus();
      broadcast({ type: 'STATUS_UPDATED', data: status });
      return res.json({
        success: true,
        message: 'Tous les canaux ont été retirés',
        status,
      });
    }

    const target = channels || channel;
    if (!target) {
      return res.status(400).json({ success: false, message: 'Nom du canal requis pour la suppression' });
    }
    const result = telegramListener.removeChannels(target);
    const status = telegramListener.getStatus();
    broadcast({ type: 'STATUS_UPDATED', data: status });
    res.json({
      success: result.removed.length > 0,
      removed: result.removed,
      message:
        result.removed.length > 0
          ? `${result.removed.length} canal(aux) retiré(s) : ${result.removed.join(', ')}`
          : 'Canal non trouvé',
      status,
    });
  });

  // Set exact list of Telegram channels dynamically
  app.post('/api/telegram/set-channels', (req, res) => {
    const { channels } = req.body;
    if (!Array.isArray(channels)) {
      return res.status(400).json({ success: false, message: 'La liste des canaux doit être un tableau' });
    }
    telegramListener.setChannels(channels);
    const status = telegramListener.getStatus();
    broadcast({ type: 'STATUS_UPDATED', data: status });
    res.json({
      success: true,
      message: `Liste mise à jour avec ${status.channels.length} canaux`,
      status,
    });
  });

  // Telegram Authentication endpoints (Phone & Code Verification)
  app.post('/api/telegram/send-code', async (req, res) => {
    try {
      const { phone } = req.body;
      const result = await telegramListener.requestPhoneCode(phone);
      broadcast({ type: 'STATUS_UPDATED', data: telegramListener.getStatus() });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message || 'Error requesting code' });
    }
  });

  app.post('/api/telegram/verify-code', async (req, res) => {
    const { code, password } = req.body;
    if (!code) {
      return res.status(400).json({ success: false, message: 'Le code de vérification Telegram est requis' });
    }
    try {
      const result = await telegramListener.submitVerificationCode(code, password);
      broadcast({ type: 'STATUS_UPDATED', data: telegramListener.getStatus() });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message || 'Échec de vérification du code' });
    }
  });

  app.post('/api/telegram/disconnect', async (req, res) => {
    const result = await telegramListener.disconnectTelegram();
    broadcast({ type: 'STATUS_UPDATED', data: telegramListener.getStatus() });
    res.json(result);
  });

  // ==========================================
  // Dashboard Security & Connection Code Endpoints
  // ==========================================
  app.get('/api/security/status', (req, res) => {
    res.json(securityManager.getStatus());
  });

  app.post('/api/security/verify', (req, res) => {
    const { code } = req.body;
    const result = securityManager.verifyCode(code);
    res.json(result);
  });

  app.post('/api/security/setup', (req, res) => {
    const { newCode, currentCode, autoLockMinutes } = req.body;
    const result = securityManager.setupCode({ newCode, currentCode, autoLockMinutes });
    if (result.success) {
      broadcast({ type: 'SECURITY_UPDATED', data: securityManager.getStatus() });
    }
    res.json(result);
  });

  app.post('/api/security/toggle', (req, res) => {
    const { enabled, currentCode } = req.body;
    const result = securityManager.toggleProtection(enabled, currentCode);
    if (result.success) {
      broadcast({ type: 'SECURITY_UPDATED', data: securityManager.getStatus() });
    }
    res.json(result);
  });

  app.post('/api/security/remove', (req, res) => {
    const { currentCode } = req.body;
    const result = securityManager.removeCode(currentCode);
    if (result.success) {
      broadcast({ type: 'SECURITY_UPDATED', data: securityManager.getStatus() });
    }
    res.json(result);
  });

  app.post('/api/security/autolock', (req, res) => {
    const { autoLockMinutes } = req.body;
    const result = securityManager.updateAutoLock(Number(autoLockMinutes) || 0);
    if (result.success) {
      broadcast({ type: 'SECURITY_UPDATED', data: securityManager.getStatus() });
    }
    res.json(result);
  });

  // Solana Wallet Import
  app.post('/api/wallet/import', async (req, res) => {
    const { privateKey } = req.body;
    if (!privateKey) {
      return res.status(400).json({ success: false, message: 'La clé privée Solana est requise' });
    }
    const result = sniperEngine.importPrivateKey(privateKey);
    const balance = await sniperEngine.refreshWalletBalance();
    broadcast({ type: 'CONFIG_UPDATED', data: sniperEngine.getConfig() });
    res.json({ ...result, balanceSol: balance });
  });

  // Wallet status & balance refresh
  app.post('/api/wallet/refresh-balance', async (req, res) => {
    try {
      const balance = await sniperEngine.refreshWalletBalance();
      broadcast({ type: 'CONFIG_UPDATED', data: sniperEngine.getConfig() });
      res.json({ success: true, balanceSol: balance });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Wallet status & balance
  app.get('/api/wallet/status', async (req, res) => {
    try {
      const balance = await sniperEngine.refreshWalletBalance();
      const config = sniperEngine.getConfig();
      res.json({
        publicKey: config.walletPublicKey,
        balanceSol: balance,
        hasPrivateKey: config.hasPrivateKey,
        executionMode: config.executionMode,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Export Wallet Private Key (for secure user backup / phantom import)
  app.get('/api/wallet/export', (req, res) => {
    try {
      const privateKey = sniperEngine.exportPrivateKey();
      const config = sniperEngine.getConfig();
      res.json({
        success: true,
        publicKey: config.walletPublicKey,
        privateKey,
        hasPrivateKey: !!privateKey,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // AWS Load Balancer / ECS Health Check
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      timestamp: Date.now(),
      environment: process.env.NODE_ENV || 'development',
      telegramConnected: telegramListener.getStatus().connected,
      executionMode: sniperEngine.getConfig().executionMode,
    });
  });

  // Dexscreener live proxy
  app.get('/api/dexscreener/:address', async (req, res) => {
    try {
      const pair = await dexscreener.getTokenPair(req.params.address);
      if (!pair) {
        return res.status(404).json({ error: 'Token pair not found' });
      }
      res.json(pair);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ================= VITE MIDDLEWARE =================
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SolSnipe] Server listening on http://0.0.0.0:${PORT}`);
  });

  // Graceful shutdown handling for AWS ECS, Docker, Kubernetes & PM2
  const shutdown = (signal: string) => {
    console.log(`[SolSnipe] Received ${signal}. Starting graceful shutdown...`);
    telegramListener.stop();
    sniperEngine.destroy();
    
    // Close SSE connections
    for (const client of sseClients) {
      try {
        client.end();
      } catch {}
    }
    
    server.close(() => {
      console.log('[SolSnipe] HTTP server closed cleanly. Exiting.');
      process.exit(0);
    });

    // Force exit if hanging after 5s
    setTimeout(() => {
      console.warn('[SolSnipe] Force exiting after timeout.');
      process.exit(1);
    }, 5000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

startServer().catch((err) => {
  console.error('[SolSnipe] Fatal startup error:', err);
  process.exit(1);
});
