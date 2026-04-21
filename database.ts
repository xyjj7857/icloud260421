import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(path.join(DATA_DIR, 'trading_data.db'));

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS raw_incomes (
    id TEXT PRIMARY KEY,
    accountId TEXT,
    symbol TEXT,
    incomeType TEXT,
    income REAL,
    asset TEXT,
    time INTEGER,
    info TEXT
  );

  CREATE TABLE IF NOT EXISTS raw_trades (
    id TEXT PRIMARY KEY,
    accountId TEXT,
    symbol TEXT,
    orderId TEXT,
    side TEXT,
    price REAL,
    qty REAL,
    realizedPnl REAL,
    marginAsset TEXT,
    quoteQty REAL,
    commission REAL,
    commissionAsset TEXT,
    time INTEGER,
    isBuyer INTEGER,
    isMaker INTEGER
  );

  CREATE TABLE IF NOT EXISTS sync_status (
    accountId TEXT,
    symbol TEXT,
    lastSyncTime INTEGER,
    PRIMARY KEY (accountId, symbol)
  );

  CREATE TABLE IF NOT EXISTS system_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    accountId TEXT,
    level TEXT,
    message TEXT,
    timestamp INTEGER
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    name TEXT,
    apiKey TEXT,
    apiSecret TEXT,
    isActive INTEGER DEFAULT 1
  );

  CREATE INDEX IF NOT EXISTS idx_incomes_account_time ON raw_incomes(accountId, time);
  CREATE INDEX IF NOT EXISTS idx_trades_account_time ON raw_trades(accountId, time);
  CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON system_logs(timestamp);
`);

export interface BinanceAccount {
  id: string;
  name: string;
  apiKey: string;
  apiSecret: string;
  isActive: boolean;
}

export interface RawIncome {
  id: string;
  accountId: string;
  symbol: string;
  incomeType: string;
  income: number;
  asset: string;
  time: number;
  info: string;
}

export interface RawTrade {
  id: string;
  accountId: string;
  symbol: string;
  orderId: string;
  side: string;
  price: number;
  qty: number;
  realizedPnl: number;
  marginAsset: string;
  quoteQty: number;
  commission: number;
  commissionAsset: string;
  time: number;
  isBuyer: number;
  isMaker: number;
}

export const saveIncomes = (incomes: RawIncome[]) => {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO raw_incomes (id, accountId, symbol, incomeType, income, asset, time, info)
    VALUES (@id, @accountId, @symbol, @incomeType, @income, @asset, @time, @info)
  `);
  
  const transaction = db.transaction((items) => {
    for (const item of items) insert.run(item);
  });
  
  transaction(incomes);
};

export const saveTrades = (trades: RawTrade[]) => {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO raw_trades (id, accountId, symbol, orderId, side, price, qty, realizedPnl, marginAsset, quoteQty, commission, commissionAsset, time, isBuyer, isMaker)
    VALUES (@id, @accountId, @symbol, @orderId, @side, @price, @qty, @realizedPnl, @marginAsset, @quoteQty, @commission, @commissionAsset, @time, @isBuyer, @isMaker)
  `);
  
  const transaction = db.transaction((items) => {
    for (const item of items) insert.run(item);
  });
  
  transaction(trades);
};

export const getSyncStatus = (accountId: string, symbol: string) => {
  return db.prepare('SELECT lastSyncTime FROM sync_status WHERE accountId = ? AND symbol = ?').get(accountId, symbol) as { lastSyncTime: number } | undefined;
};

export const updateSyncStatus = (accountId: string, symbol: string, lastSyncTime: number) => {
  db.prepare(`
    INSERT INTO sync_status (accountId, symbol, lastSyncTime)
    VALUES (?, ?, ?)
    ON CONFLICT(accountId, symbol) DO UPDATE SET lastSyncTime = excluded.lastSyncTime
  `).run(accountId, symbol, lastSyncTime);
};

export const getStoredIncomes = (accountId: string, startTime: number, endTime: number) => {
  return db.prepare(`
    SELECT * FROM raw_incomes 
    WHERE accountId = ? AND time >= ? AND time <= ?
    ORDER BY time ASC
  `).all(accountId, startTime, endTime) as RawIncome[];
};

export const getStoredTrades = (accountId: string, startTime: number, endTime: number) => {
  return db.prepare(`
    SELECT * FROM raw_trades 
    WHERE accountId = ? AND time >= ? AND time <= ?
    ORDER BY time ASC
  `).all(accountId, startTime, endTime) as RawTrade[];
};

export const getAllStoredSymbols = (accountId: string) => {
  const incomeSymbols = db.prepare('SELECT DISTINCT symbol FROM raw_incomes WHERE accountId = ? AND symbol IS NOT NULL').all(accountId) as { symbol: string }[];
  const tradeSymbols = db.prepare('SELECT DISTINCT symbol FROM raw_trades WHERE accountId = ?').all(accountId) as { symbol: string }[];
  const allSymbols = new Set([...incomeSymbols.map(s => s.symbol), ...tradeSymbols.map(s => s.symbol)]);
  return Array.from(allSymbols);
};

export const addLog = (accountId: string | null, level: 'info' | 'warn' | 'error', message: string) => {
  db.prepare('INSERT INTO system_logs (accountId, level, message, timestamp) VALUES (?, ?, ?, ?)').run(
    accountId,
    level,
    message,
    Date.now()
  );
};

export const getLogs = (limit = 100) => {
  return db.prepare('SELECT * FROM system_logs ORDER BY timestamp DESC LIMIT ?').all(limit) as {
    id: number;
    accountId: string | null;
    level: string;
    message: string;
    timestamp: number;
  }[];
};

export const getAccounts = () => {
  const rows = db.prepare('SELECT * FROM accounts').all() as any[];
  return rows.map(row => ({
    ...row,
    isActive: !!row.isActive
  })) as BinanceAccount[];
};

export const addAccount = (account: BinanceAccount) => {
  db.prepare(`
    INSERT INTO accounts (id, name, apiKey, apiSecret, isActive)
    VALUES (@id, @name, @apiKey, @apiSecret, @isActive)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      apiKey = excluded.apiKey,
      apiSecret = excluded.apiSecret,
      isActive = excluded.isActive
  `).run({
    ...account,
    isActive: account.isActive ? 1 : 0
  });
};

export const deleteAccount = (id: string) => {
  db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
};

export default db;
