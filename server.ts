import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import { USDMClient, MainClient, WebsocketClient } from "binance";
import { Server } from "socket.io";
import http from "http";
import fs from "fs";
import cookieParser from "cookie-parser";
import axios from "axios";
import { 
  saveIncomes, 
  saveTrades, 
  updateSyncStatus, 
  getSyncStatus, 
  getStoredIncomes, 
  getStoredTrades, 
  getAllStoredSymbols, 
  addLog, 
  getLogs, 
  getAccounts,
  addAccount,
  deleteAccount,
  RawIncome, 
  RawTrade,
  BinanceAccount
} from "./database.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const DATA_FILE = path.join(DATA_DIR, "accounts.json");

function migrateAccounts() {
  const dbAccounts = getAccounts();
  if (dbAccounts.length === 0 && fs.existsSync(DATA_FILE)) {
    try {
      const jsonAccounts = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
      console.log(`[Migration] Migrating ${jsonAccounts.length} accounts from JSON to SQL...`);
      for (const acc of jsonAccounts) {
        addAccount({
          ...acc,
          isActive: !!acc.isActive
        });
      }
    } catch (e) {
      console.error("[Migration] Failed to migrate accounts:", e);
    }
  }
}
migrateAccounts();

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: {
      origin: "*",
    },
  });

  const PORT = Number(process.env.PORT) || 3333;
  const GATEKEEPER_PASSWORD = process.env.GATEKEEPER_PASSWORD || "Xiemac123!";
  
  let accounts = getAccounts();
  const wsClients: Record<string, WebsocketClient> = {};
  const wsStatuses: Record<string, string> = {};
  const lastWsMessageTime: Record<string, number> = {};

  // Local state to avoid REST API calls
  const accountStates: Record<string, {
    balances: any[];
    positions: any[];
    orders: any[];
    lastUpdate: number;
  }> = {};

  const lastSyncTime: Record<string, number> = {}; // Track last sync to avoid frequency
  let pollingAccountIndex = 0;
  let lastPolledMinute = -1;

  async function updateLocalState(accountId: string, isManual: boolean = false) {
    const account = accounts.find(a => a.id === accountId);
    if (!account || !account.isActive) return;

    const interval = isManual ? 2000 : REST_INTERVAL;
    await waitForRestSlot(`获取账户快照 (${account.name})`, interval);
    
    const client = new USDMClient({ api_key: account.apiKey, api_secret: account.apiSecret });
    const mainClient = new MainClient({ api_key: account.apiKey, api_secret: account.apiSecret });

    try {
      const [futuresAccount, spotAccount] = await Promise.all([
        client.getAccountInformation(),
        mainClient.getAccountInformation()
      ]);

      const balances: any[] = [];
      
      // Futures balances
      if (futuresAccount.assets) {
        futuresAccount.assets.forEach((a: any) => {
          if (parseFloat(a.walletBalance) > 0) {
            balances.push({
              asset: a.asset,
              balance: a.walletBalance,
              available: a.availableBalance,
              type: 'futures'
            });
          }
        });
      }

      // Spot balances
      if (spotAccount.balances) {
        spotAccount.balances.forEach((b: any) => {
          if (parseFloat(b.free) > 0 || parseFloat(b.locked) > 0) {
            balances.push({
              asset: b.asset,
              balance: (parseFloat(b.free) + parseFloat(b.locked)).toString(),
              available: b.free,
              type: 'spot'
            });
          }
        });
      }

      const positions = (futuresAccount.positions || [])
        .filter((p: any) => parseFloat(p.positionAmt) !== 0)
        .map((p: any) => ({
          symbol: p.symbol,
          amount: p.positionAmt,
          entryPrice: p.entryPrice,
          markPrice: p.markPrice,
          pnl: p.unrealizedProfit
        }));

      accountStates[accountId] = {
        balances,
        positions,
        orders: accountStates[accountId]?.orders || [],
        lastUpdate: Date.now()
      };

      io.to(accountId.toString()).emit("binance_initial_data", {
        accountId,
        accountName: account.name,
        ...accountStates[accountId]
      });

      addLog(accountId, 'info', `账户快照更新成功 (${account.name})`);
    } catch (e: any) {
      addLog(accountId, 'error', `获取账户快照失败 (${account.name}): ${e.message}`);
      if (isRateLimitError(e)) {
        handleRateLimit(accountId, e.message);
      }
    }
  }

  function isQuietPeriod() {
    const now = new Date();
    const min = now.getMinutes();
    const sec = now.getSeconds();
    const minInCycle = min % 15;
    
    // 避让时段：本周期 13:50 到 下一周期 00:10 (绝对周期15分钟)
    if (minInCycle === 13 && sec >= 50) return true;
    if (minInCycle === 14) return true;
    if (minInCycle === 0 && sec <= 10) return true;
    
    return false;
  }

  async function waitIfQuiet(context: string) {
    while (isQuietPeriod()) {
      const now = new Date();
      const min = now.getMinutes();
      const sec = now.getSeconds();
      const msg = `[静默窗口] 检测到高峰避让时段 (${min}分${sec}秒)，暂停 ${context} 以确保主程序稳定...`;
      addLog(null, 'info', msg);
      
      // 计算需要等待到避让结束的时间 (下一周期的 00:11)
      const minInCycle = min % 15;
      let secondsToWait = 0;
      if (minInCycle === 13 || minInCycle === 14) {
        secondsToWait = (14 - minInCycle) * 60 + (60 - sec) + 11;
      } else if (minInCycle === 0) {
        secondsToWait = 11 - sec;
      }
      
      if (secondsToWait <= 0) secondsToWait = 1;

      await new Promise(resolve => setTimeout(resolve, secondsToWait * 1000));
      
      const endMsg = `[静默窗口] 避让时段已过，恢复 ${context}。`;
      addLog(null, 'info', endMsg);
    }
  }

  // Global Request Queue to ensure 27s interval between REST calls
  let lastRestCallTime = 0;
  const REST_INTERVAL = 27000; // 27 seconds
  let isRateLimited = false;
  let rateLimitExpiry = 0;

  async function handleRateLimit(accountId: string | null, errorMsg: string) {
    if (isRateLimited && Date.now() < rateLimitExpiry) return; // Already in pause
    
    isRateLimited = true;
    rateLimitExpiry = Date.now() + 120000; // 2 minutes
    const msg = `[限流报警] 检测到 API 限流 (${errorMsg})。立即暂停所有 REST 请求，等待 2 分钟并重置队列...`;
    addLog(accountId, 'error', msg);
    
    // Reset queue timer to start AFTER the 2-minute wait
    lastRestCallTime = rateLimitExpiry; 
    
    setTimeout(() => {
      isRateLimited = false;
      const resumeMsg = `[限流解除] 2 分钟等待已结束，REST 请求队列恢复。`;
      console.log(resumeMsg);
      addLog(null, 'info', resumeMsg);
    }, 120000);
  }

  async function waitForRestSlot(context: string, intervalOverride?: number) {
    // 1. Check Rate Limit Pause
    while (isRateLimited && Date.now() < rateLimitExpiry) {
      const waitTime = rateLimitExpiry - Date.now();
      if (waitTime > 0) {
        await new Promise(resolve => setTimeout(resolve, Math.min(waitTime, 2000)));
      } else {
        isRateLimited = false;
      }
    }

    // 2. Maintain Interval
    const interval = intervalOverride !== undefined ? intervalOverride : REST_INTERVAL;
    const now = Date.now();
    const timeSinceLastCall = now - lastRestCallTime;
    
    if (timeSinceLastCall < interval) {
      const waitTime = interval - timeSinceLastCall;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    // 3. Respect Quiet Period
    await waitIfQuiet(context);
    
    lastRestCallTime = Date.now();
  }

  function isRateLimitError(e: any): boolean {
    const msg = e?.message || String(e);
    return msg.includes('429') || msg.includes('Way too many requests') || msg.includes('banned');
  }

  async function syncAccountIncomes(accountId: string, startTime: number, endTime: number) {
    const account = accounts.find(a => a.id === accountId);
    if (!account || !account.isActive) return;
    await waitForRestSlot(`资金流水同步 (${account.name})`);
    const client = new USDMClient({ api_key: account.apiKey, api_secret: account.apiSecret });
    try {
      let currentStart = startTime;
      let allIncomes: any[] = [];
      
      while (currentStart < endTime) {
        const income = await client.getIncomeHistory({ startTime: currentStart, endTime, limit: 1000 });
        if (!Array.isArray(income) || income.length === 0) break;
        
        allIncomes = [...allIncomes, ...income];
        if (income.length < 1000) break;
        
        // Update currentStart to last record time + 1ms
        currentStart = Number(income[income.length - 1].time) + 1;
      }

      if (allIncomes.length > 0) {
        saveIncomes(allIncomes.map((i: any) => ({
          id: i.tranId,
          accountId,
          symbol: i.symbol,
          incomeType: i.incomeType,
          income: Number(i.income),
          asset: i.asset,
          time: Number(i.time),
          info: JSON.stringify(i)
        })));
        addLog(accountId, 'info', `资金流水同步完成 (${account.name}): ${allIncomes.length} 条记录`);
      }
    } catch (e: any) {
      console.error(`[Sync Incomes] Error for ${account.name}:`, e.message);
      addLog(accountId, 'error', `资金流水同步失败 (${account.name}): ${e.message}`);
      if (isRateLimitError(e)) {
        handleRateLimit(accountId, e.message);
      }
    }
  }

  async function syncAccountTrades(accountId: string, startTime: number, endTime: number) {
    const account = accounts.find(a => a.id === accountId);
    if (!account || !account.isActive) return;
    await waitForRestSlot(`成交记录同步 (${account.name})`);
    const client = new USDMClient({ api_key: account.apiKey, api_secret: account.apiSecret });
    try {
      // Get all symbols that have trades in the DB (from incomes sync)
      let symbols = getAllStoredSymbols(accountId);
      if (symbols.length === 0) {
        console.log(`[Sync Trades] No symbols found in local DB for ${accountId}. Please sync incomes first.`);
        return;
      }

      for (const sym of symbols) {
        let currentStart = startTime;
        let symbolTrades: any[] = [];
        
        while (currentStart < endTime) {
          const trades = await client.getAccountTrades({ symbol: sym, startTime: currentStart, endTime, limit: 1000 });
          if (!Array.isArray(trades) || trades.length === 0) break;
          
          symbolTrades = [...symbolTrades, ...trades];
          if (trades.length < 1000) break;
          
          currentStart = Number(trades[trades.length - 1].time) + 1;
        }

        if (symbolTrades.length > 0) {
          saveTrades(symbolTrades.map((t: any) => ({
            id: t.id.toString(),
            accountId,
            symbol: t.symbol,
            orderId: t.orderId.toString(),
            side: t.side,
            price: Number(t.price),
            qty: Number(t.qty),
            realizedPnl: Number(t.realizedPnl),
            marginAsset: t.marginAsset,
            quoteQty: Number(t.quoteQty),
            commission: Number(t.commission),
            commissionAsset: t.commissionAsset,
            time: Number(t.time),
            isBuyer: (t.isBuyer !== undefined ? t.isBuyer : (t.buyer !== undefined ? t.buyer : t.side === 'BUY')) ? 1 : 0,
            isMaker: t.isMaker ? 1 : 0,
            info: JSON.stringify(t)
          })));
        }
        await new Promise(resolve => setTimeout(resolve, 500)); // Delay between symbols
      }
      addLog(accountId, 'info', `成交记录同步完成 (${account.name})`);
    } catch (e: any) {
      console.error(`[Sync Trades] Error for ${account.name}:`, e.message);
      addLog(accountId, 'error', `成交记录同步失败 (${account.name}): ${e.message}`);
      if (isRateLimitError(e)) {
        handleRateLimit(accountId, e.message);
      }
    }
  }

  let apiStatus = "Connected";
  let serverIp = "REST Disabled";

  // Fetch server IP
  const fetchServerIp = async () => {
    try {
      const response = await axios.get("https://api.ipify.org?format=json", { timeout: 5000 });
      serverIp = response.data.ip;
      console.log(`[System] Server Public IP: ${serverIp}`);
    } catch (e: any) {
      console.error("[System] Failed to fetch server IP:", e.message);
      serverIp = "Fetch Failed";
    }
  };
  fetchServerIp();

  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(cookieParser());

  // Gatekeeper Middleware
  const authMiddleware = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    // When mounted on /api, req.path is relative to /api
    if (req.path === "/login" || req.path.startsWith("/system/status")) {
      return next();
    }
    
    const authCookie = req.cookies.gatekeeper_token;
    const authHeader = req.headers.authorization;
    const authToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;
    
    if (authCookie === GATEKEEPER_PASSWORD || authToken === GATEKEEPER_PASSWORD) {
      next();
    } else {
      res.status(401).json({ error: "Unauthorized" });
    }
  };

  app.use("/api", authMiddleware);

  // Auth Routes
  app.post("/api/login", (req, res) => {
    const { password } = req.body;
    if (password === GATEKEEPER_PASSWORD) {
      const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
      
      res.cookie("gatekeeper_token", GATEKEEPER_PASSWORD, { 
        httpOnly: true, 
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        sameSite: isSecure ? 'none' : 'lax',
        secure: isSecure
      });
      
      res.json({ success: true, token: GATEKEEPER_PASSWORD });
    } else {
      res.status(401).json({ error: "Invalid password" });
    }
  });

  app.post("/api/logout", (req, res) => {
    res.clearCookie("gatekeeper_token");
    res.json({ success: true });
  });

  // API Routes
  app.get("/api/system/logs", (req, res) => {
    res.json(getLogs());
  });

  app.get("/api/system/status", (req, res) => {
    const wsConnectedCount = Object.values(wsClients).length;
    res.json({
      apiStatus,
      wsStatus: wsConnectedCount > 0 ? "Connected" : "Disconnected",
      serverIp
    });
  });
  app.get("/api/accounts", (req, res) => {
    res.json(accounts.map(({ id, name, isActive }) => ({ id, name, isActive })));
  });

  app.post("/api/binance/transfer", async (req, res) => {
    const { accountId, asset, amount } = req.body;
    const account = accounts.find(a => a.id === accountId);
    if (!account) return res.status(404).json({ error: "Account not found" });

    try {
      await waitForRestSlot(`资金划转 (${account.name})`, 2000);
      const mainClient = new MainClient({ api_key: account.apiKey, api_secret: account.apiSecret });
      
      // Type 1: MAIN_UMFUTURE (Spot to USDT-M Futures)
      const result = await mainClient.submitNewFutureAccountTransfer({
        asset,
        amount: parseFloat(amount),
        type: 1
      });

      addLog(accountId, 'info', `资金划转成功 (${account.name}): ${amount} ${asset} 从现货到合约`);
      res.json({ success: true, result });
    } catch (e: any) {
      console.error(`[Transfer] Error for ${account.name}:`, e.message);
      addLog(accountId, 'error', `资金划转失败 (${account.name}): ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/binance/history", async (req, res) => {
    const { accountIds, startTime, endTime } = req.body;
    try {
      const targetIds = accountIds && accountIds.length > 0 ? accountIds : accounts.map(a => a.id);
      let allHistory: any[] = [];

      for (const accountId of targetIds) {
        const account = accounts.find(a => a.id === accountId);
        if (!account) continue;

        // Fetch trades with more context to catch position starts
        const contextStartTime = startTime - (90 * 24 * 60 * 60 * 1000); 
        const trades = getStoredTrades(accountId, contextStartTime, endTime);
        const incomes = getStoredIncomes(accountId, contextStartTime, endTime);

        const symbols = Array.from(new Set(trades.map(t => t.symbol)));
        
        for (const symbol of symbols) {
          const symbolTrades = trades.filter(t => t.symbol === symbol).sort((a, b) => a.time - b.time);
          const symbolIncomes = incomes.filter(i => i.symbol === symbol);

          let currentPosition: any = null;
          let runningQty = 0;
          let phase: 'OPENING' | 'CLOSING' = 'OPENING';

          const finalizePosition = (pos: any, currentRunningQty: number) => {
            if (!pos || pos.trades.length === 0) return;
            
            // Only include if it has some activity in the requested range
            const hasActivityInRange = pos.trades.some((t: any) => t.time >= startTime && t.time <= endTime);
            if (!hasActivityInRange) return;

            // Calculate weighted average prices
            const openTrades = pos.trades.filter((t: any) => {
              const isBuyer = !!t.isBuyer || t.side === 'BUY' || t.side === 'buy';
              return pos.side === 'LONG' ? isBuyer : !isBuyer;
            });
            const closeTrades = pos.trades.filter((t: any) => {
              const isBuyer = !!t.isBuyer || t.side === 'BUY' || t.side === 'buy';
              return pos.side === 'LONG' ? !isBuyer : isBuyer;
            });
            
            const totalOpenQty = openTrades.reduce((sum: number, t: any) => sum + t.qty, 0);
            const totalOpenCost = openTrades.reduce((sum: number, t: any) => sum + (t.qty * t.price), 0);
            pos.openPrice = totalOpenQty > 0 ? (totalOpenCost / totalOpenQty) : pos.openPrice;

            const totalCloseQty = closeTrades.reduce((sum: number, t: any) => sum + t.qty, 0);
            const totalCloseCost = closeTrades.reduce((sum: number, t: any) => sum + (t.qty * t.price), 0);
            
            if (totalCloseQty > 0) {
              pos.closePrice = totalCloseCost / totalCloseQty;
            } else {
              pos.closePrice = pos.openPrice;
            }
            
            pos.qty = totalOpenQty;

            // Funding fees during this position's lifespan
            const posFunding = symbolIncomes.filter(i => i.incomeType === 'FUNDING_FEE' && i.time >= pos.openTime && i.time <= pos.closeTime);
            pos.fundingFee = posFunding.reduce((sum, i) => sum + i.income, 0);
            
            pos.totalPnL = pos.realizedPnL + pos.fundingFee - pos.commission;
            pos.isOpen = Math.abs(currentRunningQty) > 1e-5;
            
            allHistory.push(pos);
          };

          for (const trade of symbolTrades) {
            const tradeQty = Math.abs(trade.qty);
            const tradePrice = trade.price;
            // Robust buyer detection: check isBuyer field OR side string
            const isBuyer = !!trade.isBuyer || trade.side === 'BUY' || trade.side === 'buy';
            const tradeSide = isBuyer ? 'LONG' : 'SHORT';
            const tradeSignedQty = isBuyer ? tradeQty : -tradeQty;
            
            if (!currentPosition) {
              currentPosition = {
                accountName: account.name,
                symbol: symbol,
                openTime: trade.time,
                closeTime: trade.time,
                side: tradeSide,
                openPrice: tradePrice,
                closePrice: tradePrice,
                qty: tradeQty,
                realizedPnL: trade.realizedPnl || 0,
                commission: trade.commission || 0,
                fundingFee: 0,
                trades: [trade]
              };
              runningQty = tradeSignedQty;
              phase = 'OPENING';
            } else {
              const prevQty = runningQty;
              const newQty = runningQty + tradeSignedQty;

              // Check if we should finalize the current position based on direction sequence or flip
              const isNewOpeningAfterClosing = (phase === 'CLOSING' && tradeSide === currentPosition.side);
              const isFlipped = (prevQty > 0 && newQty < -1e-5) || (prevQty < 0 && newQty > 1e-5);

              if (isNewOpeningAfterClosing || isFlipped) {
                finalizePosition(currentPosition, isFlipped ? 0 : runningQty);
                // Start new cycle
                currentPosition = {
                  accountName: account.name,
                  symbol: symbol,
                  openTime: trade.time,
                  closeTime: trade.time,
                  side: isFlipped ? (newQty > 0 ? 'LONG' : 'SHORT') : tradeSide,
                  openPrice: tradePrice,
                  closePrice: tradePrice,
                  qty: isFlipped ? Math.abs(newQty) : tradeQty,
                  realizedPnL: trade.realizedPnl || 0,
                  commission: trade.commission || 0,
                  fundingFee: 0,
                  trades: [trade]
                };
                runningQty = isFlipped ? newQty : tradeSignedQty;
                phase = 'OPENING';
              } else {
                // Update phase if direction is opposite to start
                if (phase === 'OPENING' && tradeSide !== currentPosition.side) {
                  phase = 'CLOSING';
                }

                runningQty = newQty;
                currentPosition.realizedPnL += (trade.realizedPnl || 0);
                currentPosition.commission += (trade.commission || 0);
                currentPosition.trades.push(trade);
                currentPosition.closeTime = trade.time;

                // If position fully closed by quantity
                if (Math.abs(runningQty) < 1e-5) {
                  finalizePosition(currentPosition, 0);
                  currentPosition = null;
                  runningQty = 0;
                  phase = 'OPENING';
                }
              }
            }
          }
          if (currentPosition) {
            finalizePosition(currentPosition, runningQty);
          }
        }
      }

      allHistory.sort((a, b) => b.closeTime - a.closeTime);
      res.json(allHistory);
    } catch (e: any) {
      console.error("[History API] Error:", e);
      res.status(500).json({ error: e.message });
    }
  });

  function closeAccountWS(accountId: string) {
    if (wsClients[accountId]) {
      try {
        wsClients[accountId].closeAll();
        delete wsClients[accountId];
        wsStatuses[accountId] = 'disconnected';
        io.emit("ws_status", { accountId, status: 'disconnected' });
      } catch (e) {
        console.error(`Error closing WS for ${accountId}:`, e);
      }
    }
  }

  function initAccountWS(account: BinanceAccount) {
    if (wsClients[account.id]) return;
    if (!account.isActive) return;

    console.log(`[WS Init] Starting WebSocket for ${account.name}`);
    const wsClient = new WebsocketClient({
      api_key: account.apiKey,
      api_secret: account.apiSecret,
      beautify: true,
    }, undefined);

    (wsClient as any).options = {
      ...((wsClient as any).options || {}),
      keepAlive: true,
      reconnectOptions: {
        keepAlive: true,
        delay: 5000,
        maxDelay: 60000,
        retries: 100
      }
    };

    wsClient.on("formattedMessage", (data: any) => {
      lastWsMessageTime[account.id] = Date.now();
      const state = accountStates[account.id];
      if (state) {
        if (data.eventType === 'ACCOUNT_UPDATE') {
          const update = data.updateData;
          
          if (update.updatedBalances) {
            update.updatedBalances.forEach((ub: any) => {
              const existing = state.balances.find(b => b.asset === ub.asset && b.type === 'futures');
              if (existing) {
                existing.balance = ub.walletBalance;
                existing.available = ub.crossWalletBalance;
              } else if (parseFloat(ub.walletBalance) > 0) {
                state.balances.push({
                  asset: ub.asset,
                  balance: ub.walletBalance,
                  available: ub.crossWalletBalance,
                  type: 'futures'
                });
              }
            });
          }

          // Emit only to the specific account room
          io.to(account.id.toString()).emit("binance_update", { accountId: account.id, accountName: account.name, data });
        }
      }
    });

    (wsClient as any).on("open", (data: any) => {
      addLog(account.id, 'info', `WebSocket 连接成功 (${account.name})`);
      wsStatuses[account.id] = 'connected';
      io.to(account.id.toString()).emit("ws_status", { accountId: account.id, status: 'connected' });
      io.emit("system_status_update");
    });

    let reconnectDelay = 5000;
    const maxReconnectDelay = 60000;

    (wsClient as any).on("reconnecting", (data: any) => {
      addLog(account.id, 'warn', `WebSocket 正在重连 (${account.name}): 第 ${data.attempt} 次尝试`);
      wsStatuses[account.id] = 'reconnecting';
      io.to(account.id.toString()).emit("ws_status", { accountId: account.id, status: 'reconnecting' });
      reconnectDelay = Math.min(reconnectDelay * 1.5, maxReconnectDelay);
    });

    (wsClient as any).on("reconnected", (data: any) => {
      addLog(account.id, 'info', `WebSocket 重连成功 (${account.name})`);
      reconnectDelay = 5000;
      wsStatuses[account.id] = 'connected';
      io.to(account.id.toString()).emit("ws_status", { accountId: account.id, status: 'connected' });
    });

    (wsClient as any).on("error", (err: any) => {
      addLog(account.id, 'error', `WebSocket 错误 (${account.name}): ${err.message || JSON.stringify(err)}`);
      wsStatuses[account.id] = 'error';
      io.to(account.id.toString()).emit("ws_status", { accountId: account.id, status: 'error' });
    });

    wsClient.subscribeUsdFuturesUserDataStream();
    wsClient.subscribeSpotUserDataStream();
    // wsClient.subscribeAllMarketMarkPrice('usdm'); // USER REQUEST: No mark price updates
    
    wsClients[account.id] = wsClient;
    wsStatuses[account.id] = 'connecting';
    io.emit("ws_status", { accountId: account.id, status: 'connecting' });
  }

  // Background Sync Logic Removed (Replaced by staggered daily sync)

  // WebSocket Logic
  io.on("connection", (socket) => {
    // Automatically subscribe to all accounts for global monitoring
    accounts.forEach(async (account) => {
      const room = account.id.toString();
      socket.join(room);
      
      if (!account.isActive) {
        socket.emit("ws_status", { accountId: account.id, status: 'disconnected' });
        return;
      }

      // Send current WS status directly to the connected socket
      socket.emit("ws_status", { 
        accountId: account.id, 
        status: wsStatuses[account.id] || 'connecting' 
      });

      // Serve from local state if available directly to the connected socket
      if (accountStates[account.id]) {
        socket.emit("binance_initial_data", {
          accountId: account.id,
          accountName: account.name,
          ...accountStates[account.id]
        });
      }
    });

    socket.on("subscribe", (accountId) => {
      if (accountId) {
        const room = accountId.toString();
        socket.join(room);
        
        // After manual subscription, send the latest state for that specific account
        if (wsStatuses[accountId]) {
          socket.emit("ws_status", { accountId, status: wsStatuses[accountId] });
        }
        
        if (accountStates[accountId]) {
          socket.emit("binance_initial_data", {
            accountId,
            accountName: accounts.find(a => a.id === accountId)?.name || 'Unknown',
            ...accountStates[accountId]
          });
        }
      }
    });

    socket.on("refresh_data", async (accountId) => {
      console.log(`[Socket] Manual refresh requested for ${accountId}`);
      await updateLocalState(accountId, true);
    });

    socket.on("unsubscribe", (accountId) => {
      socket.leave(accountId);
    });
  });

  // 1. Startup Logic: Staggered Initialization (Serialized Queue)
  const startupAccounts = async () => {
    const dbAccounts = getAccounts();
    for (const account of dbAccounts) {
      if (account.isActive) {
        initAccountWS(account);
        // Fetch initial state via REST
        updateLocalState(account.id);
        // Staggered delay to respect the 27s queue and avoid burst
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  };
  startupAccounts();

  // 2. Daily Sync Logic (Staggered 15m intervals starting at 08:02)
  let lastProcessedMin = -1;
  setInterval(() => {
    const now = new Date();
    const hour = now.getHours();
    const min = now.getMinutes();
    const sec = now.getSeconds();
    
    if (sec === 18 && min !== lastPolledMinute) {
      lastPolledMinute = min;
      const activeAccounts = accounts.filter(a => a.isActive);
      if (activeAccounts.length > 0) {
        if (pollingAccountIndex >= activeAccounts.length) {
          pollingAccountIndex = 0;
        }
        const account = activeAccounts[pollingAccountIndex];
        updateLocalState(account.id);
        pollingAccountIndex = (pollingAccountIndex + 1) % activeAccounts.length;
      }
    }

    if (min !== lastProcessedMin) {
      lastProcessedMin = min;
      
      // Check for 08:00+ syncs (Server Local Time)
      if (hour === 8) {
        accounts.forEach((account, index) => {
          if (!account.isActive) return;
          
          const tradeMin = 2 + (index * 15);
          const incomeMin = 3 + (index * 15);
          
          if (min === tradeMin) {
            const today8am = new Date(now);
            today8am.setHours(8, 0, 0, 0);
            const yesterday8am = new Date(today8am.getTime() - 24 * 60 * 60 * 1000);
            syncAccountTrades(account.id, yesterday8am.getTime(), today8am.getTime());
          }
          
          if (min === incomeMin) {
            const today8am = new Date(now);
            today8am.setHours(8, 0, 0, 0);
            const yesterday8am = new Date(today8am.getTime() - 24 * 60 * 60 * 1000);
            syncAccountIncomes(account.id, yesterday8am.getTime(), today8am.getTime());
          }
        });
      }

      // 3. WebSocket Keep-Alive/Refresh (27m and 57m)
      if (min === 27 || min === 57) {
        accounts.forEach(account => {
          if (account.isActive && wsClients[account.id]) {
            closeAccountWS(account.id);
            setTimeout(() => initAccountWS(account), 2000);
          }
        });
      }

      // 4. WebSocket Activity Monitor (Check every minute)
      accounts.forEach(account => {
        if (account.isActive && wsClients[account.id]) {
          const lastMsg = lastWsMessageTime[account.id] || 0;
          const nowMs = Date.now();
          // If no message for 15 minutes, reconnect (could be a dead connection)
          if (lastMsg > 0 && (nowMs - lastMsg > 900000)) {
            addLog(account.id, 'warn', `检测到 WebSocket 15分钟无活动，正在尝试重连 (${account.name})`);
            closeAccountWS(account.id);
            setTimeout(() => {
              initAccountWS(account);
              updateLocalState(account.id);
            }, 2000);
            lastWsMessageTime[account.id] = nowMs; // Reset timer
          }
        }
      });
    }
  }, 2000);

  // Account Management Endpoints
  app.get("/api/accounts", (req, res) => {
    res.json(getAccounts());
  });

  app.post("/api/accounts", (req, res) => {
    const { name, apiKey, apiSecret } = req.body;
    if (!name || !apiKey || !apiSecret) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    
    const id = Math.random().toString(36).substring(2, 10);
    const newAccount: BinanceAccount = {
      id,
      name: name.trim(),
      apiKey: apiKey.trim(),
      apiSecret: apiSecret.trim(),
      isActive: true
    };
    
    addAccount(newAccount);
    addLog(id, 'info', `成功添加新账户: ${name.trim()} (ID: ${id})`);
    accounts = getAccounts();
    
    // Initialize WS for the new account
    initAccountWS(newAccount);
    
    res.json({ success: true, account: newAccount });
  });

  app.delete("/api/accounts/:id", (req, res) => {
    const { id } = req.params;
    
    // Stop WS client if exists
    if (wsClients[id]) {
      wsClients[id].closeAll();
      delete wsClients[id];
    }
    
    deleteAccount(id);
    accounts = getAccounts();
    
    res.json({ success: true });
  });

  app.post("/api/accounts/bulk-toggle", (req, res) => {
    const { active } = req.body;
    
    accounts.forEach(account => {
      addAccount({
        ...account,
        isActive: active
      });
      
      if (active) {
        if (!wsClients[account.id]) {
          initAccountWS(account);
        }
      } else {
        if (wsClients[account.id]) {
          wsClients[account.id].closeAll();
          delete wsClients[account.id];
        }
        wsStatuses[account.id] = 'disconnected';
        io.emit("ws_status", { accountId: account.id, status: 'disconnected' });
      }
    });
    
    accounts = getAccounts();
    res.json({ success: true });
  });

  app.post("/api/accounts/:id/toggle", (req, res) => {
    const { id } = req.params;
    const account = accounts.find(a => a.id === id);
    if (!account) return res.status(404).json({ error: "Account not found" });
    
    const newStatus = !account.isActive;
    addAccount({
      ...account,
      isActive: newStatus
    });
    
    accounts = getAccounts();
    
    if (newStatus) {
      initAccountWS(account);
    } else {
      if (wsClients[id]) {
        wsClients[id].closeAll();
        delete wsClients[id];
      }
      wsStatuses[id] = 'disconnected';
      io.emit("ws_status", { accountId: id, status: 'disconnected' });
    }
    
    res.json({ success: true, isActive: newStatus });
  });

  // Manual sync trigger endpoint (Updated to fetch custom date range)
  app.post("/api/system/sync", async (req, res) => {
    const { accountId, startTime, endTime } = req.body;
    if (accountId) {
      const now = new Date();
      const finalEndTime = endTime || now.getTime();
      const finalStartTime = startTime || (finalEndTime - (3 * 24 * 60 * 60 * 1000)); // Default 3 days
      
      const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
      let currentStart = finalStartTime;
      
      console.log(`[Manual Sync] Triggering chunked sync for account ${accountId} from ${new Date(finalStartTime).toISOString()} to ${new Date(finalEndTime).toISOString()}`);
      
      while (currentStart < finalEndTime) {
        const currentEnd = Math.min(currentStart + SEVEN_DAYS, finalEndTime);
        console.log(`[Manual Sync] Processing chunk: ${new Date(currentStart).toISOString()} - ${new Date(currentEnd).toISOString()}`);
        await syncAccountIncomes(accountId, currentStart, currentEnd);
        await syncAccountTrades(accountId, currentStart, currentEnd);
        currentStart = currentEnd + 1;
        // Small delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      res.json({ success: true, message: "Manual sync triggered" });
    } else {
      res.status(400).json({ error: "Account ID required" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
