import Database from 'better-sqlite3';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const db = new Database(path.join(DATA_DIR, 'trading_data.db'));

try {
  const logs = db.prepare("SELECT * FROM system_logs ORDER BY timestamp DESC LIMIT 10").all() as any[];
  console.log('--- LATEST LOGS ---');
  logs.forEach(l => {
     console.log(`[${new Date(l.timestamp).toLocaleString()}] [${l.level}] ${l.message}`);
  });
} catch (e) {
  console.error(e);
}
