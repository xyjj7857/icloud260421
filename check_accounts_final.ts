import Database from 'better-sqlite3';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const db = new Database(path.join(DATA_DIR, 'trading_data.db'));

try {
  const accounts = db.prepare("SELECT id, name, isActive FROM accounts").all();
  console.log(JSON.stringify(accounts, null, 2));
} catch (e) {
  console.error(e);
}
