-- ToastCoin Exchange D1 schema.
--
-- Apply with:
--   wrangler d1 execute toastcoin-market --remote --file=schema/schema.sql
--   wrangler d1 execute toastcoin-market --local  --file=schema/schema.sql

CREATE TABLE IF NOT EXISTS balances (
    address      TEXT PRIMARY KEY,
    toast        REAL NOT NULL DEFAULT 0,
    chf          REAL NOT NULL DEFAULT 0,
    toast_locked REAL NOT NULL DEFAULT 0,
    chf_locked   REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    address    TEXT NOT NULL,
    side       TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    amount     REAL NOT NULL,
    remaining  REAL NOT NULL,
    price      REAL NOT NULL,
    created_at INTEGER NOT NULL,
    status     TEXT NOT NULL DEFAULT 'open'
);

CREATE INDEX IF NOT EXISTS idx_orders_book
    ON orders (side, status, price);

CREATE INDEX IF NOT EXISTS idx_orders_address
    ON orders (address, status);

CREATE TABLE IF NOT EXISTS trades (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    buy_order_id  INTEGER NOT NULL,
    sell_order_id INTEGER NOT NULL,
    amount        REAL NOT NULL,
    price         REAL NOT NULL,
    timestamp     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trades_time
    ON trades (timestamp);

CREATE TABLE IF NOT EXISTS price_history (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    price     REAL NOT NULL,
    volume    REAL NOT NULL DEFAULT 0,
    timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_price_history_time
    ON price_history (timestamp);

CREATE TABLE IF NOT EXISTS faucet_claims (
    address    TEXT PRIMARY KEY,
    last_claim INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mining_sessions (
    id           TEXT PRIMARY KEY,
    address      TEXT NOT NULL,
    started_at   INTEGER NOT NULL,
    last_claim   INTEGER NOT NULL,
    total_reward REAL NOT NULL DEFAULT 0,
    active       INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_mining_address
    ON mining_sessions (address, active);
