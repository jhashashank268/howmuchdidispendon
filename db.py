import os
import json
from datetime import datetime

DATABASE_URL = os.getenv("DATABASE_URL")

if DATABASE_URL:
    # PostgreSQL (production)
    import psycopg2
    import psycopg2.extras

    def get_conn():
        conn = psycopg2.connect(DATABASE_URL)
        return conn

    def _fetchone(conn, query, params=()):
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(query, params)
        row = cur.fetchone()
        cur.close()
        return dict(row) if row else None

    def _fetchall(conn, query, params=()):
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(query, params)
        rows = cur.fetchall()
        cur.close()
        return [dict(r) for r in rows]

    def _execute(conn, query, params=()):
        cur = conn.cursor()
        cur.execute(query, params)
        cur.close()

    PH = "%s"  # PostgreSQL placeholder

else:
    # SQLite (local dev)
    import sqlite3

    DB_PATH = os.path.join(os.path.dirname(__file__), "data", "dog_spending.db")

    def get_conn():
        os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def _fetchone(conn, query, params=()):
        row = conn.execute(query, params).fetchone()
        return dict(row) if row else None

    def _fetchall(conn, query, params=()):
        rows = conn.execute(query, params).fetchall()
        return [dict(r) for r in rows]

    def _execute(conn, query, params=()):
        conn.execute(query, params)

    PH = "?"  # SQLite placeholder


def init_db():
    conn = get_conn()
    if DATABASE_URL:
        _execute(conn, """
            CREATE TABLE IF NOT EXISTS linked_accounts (
                id SERIAL PRIMARY KEY,
                item_id TEXT UNIQUE NOT NULL,
                access_token TEXT NOT NULL,
                institution_name TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            )""")
        _execute(conn, """
            CREATE TABLE IF NOT EXISTS accounts (
                id SERIAL PRIMARY KEY,
                item_id TEXT NOT NULL,
                account_id TEXT UNIQUE NOT NULL,
                name TEXT, type TEXT, subtype TEXT,
                available_balance REAL, current_balance REAL,
                updated_at TIMESTAMP DEFAULT NOW()
            )""")
        _execute(conn, """
            CREATE TABLE IF NOT EXISTS analysis_cache (
                id SERIAL PRIMARY KEY,
                cache_key TEXT NOT NULL,
                analysis_json TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT NOW()
            )""")
        _execute(conn, """
            CREATE TABLE IF NOT EXISTS transaction_cache (
                id SERIAL PRIMARY KEY,
                cache_key TEXT UNIQUE NOT NULL,
                transactions_json TEXT NOT NULL,
                institution_names TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            )""")
        _execute(conn, """
            CREATE TABLE IF NOT EXISTS user_settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                pet_name TEXT DEFAULT 'my dog',
                analysis_days INTEGER DEFAULT 90,
                updated_at TIMESTAMP DEFAULT NOW()
            )""")
        _execute(conn, """
            INSERT INTO user_settings (id, pet_name, analysis_days)
            VALUES (1, 'my dog', 90) ON CONFLICT (id) DO NOTHING""")
    else:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS linked_accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                item_id TEXT UNIQUE NOT NULL,
                access_token TEXT NOT NULL,
                institution_name TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                item_id TEXT NOT NULL,
                account_id TEXT UNIQUE NOT NULL,
                name TEXT, type TEXT, subtype TEXT,
                available_balance REAL, current_balance REAL,
                updated_at TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (item_id) REFERENCES linked_accounts(item_id)
            );
            CREATE TABLE IF NOT EXISTS analysis_cache (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                cache_key TEXT NOT NULL,
                analysis_json TEXT NOT NULL,
                created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS transaction_cache (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                cache_key TEXT UNIQUE NOT NULL,
                transactions_json TEXT NOT NULL,
                institution_names TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS user_settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                pet_name TEXT DEFAULT 'my dog',
                analysis_days INTEGER DEFAULT 90,
                updated_at TEXT DEFAULT (datetime('now'))
            );
        """)
        conn.execute(
            "INSERT OR IGNORE INTO user_settings (id, pet_name, analysis_days) VALUES (1, 'my dog', 90)"
        )
    conn.commit()
    conn.close()


# --- linked_accounts ---

def save_linked_account(item_id, access_token, institution_name=None):
    conn = get_conn()
    if DATABASE_URL:
        _execute(conn, """INSERT INTO linked_accounts (item_id, access_token, institution_name)
            VALUES (%s, %s, %s) ON CONFLICT (item_id) DO UPDATE SET access_token=EXCLUDED.access_token""",
            (item_id, access_token, institution_name))
    else:
        _execute(conn, """INSERT INTO linked_accounts (item_id, access_token, institution_name)
            VALUES (?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET access_token=excluded.access_token""",
            (item_id, access_token, institution_name))
    conn.commit()
    conn.close()


def get_all_access_tokens():
    conn = get_conn()
    rows = _fetchall(conn, "SELECT item_id, access_token, institution_name FROM linked_accounts ORDER BY created_at")
    conn.close()
    return rows


# --- accounts ---

def upsert_accounts(item_id, accounts_data):
    conn = get_conn()
    for a in accounts_data:
        bal = a.get("balances", {})
        if DATABASE_URL:
            _execute(conn, """INSERT INTO accounts (item_id, account_id, name, type, subtype,
                available_balance, current_balance, updated_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,NOW())
                ON CONFLICT (account_id) DO UPDATE SET
                    available_balance=EXCLUDED.available_balance,
                    current_balance=EXCLUDED.current_balance, updated_at=NOW()""",
                (item_id, a["account_id"], a.get("name"), a.get("type"),
                 a.get("subtype"), bal.get("available"), bal.get("current")))
        else:
            _execute(conn, """INSERT INTO accounts (item_id, account_id, name, type, subtype,
                available_balance, current_balance, updated_at)
                VALUES (?,?,?,?,?,?,?,datetime('now'))
                ON CONFLICT(account_id) DO UPDATE SET
                    available_balance=excluded.available_balance,
                    current_balance=excluded.current_balance, updated_at=excluded.updated_at""",
                (item_id, a["account_id"], a.get("name"), a.get("type"),
                 a.get("subtype"), bal.get("available"), bal.get("current")))
    conn.commit()
    conn.close()


# --- analysis cache ---

def cache_analysis(cache_key, analysis_dict):
    conn = get_conn()
    p = PH
    _execute(conn, f"DELETE FROM analysis_cache WHERE cache_key = {p}", (cache_key,))
    _execute(conn, f"INSERT INTO analysis_cache (cache_key, analysis_json) VALUES ({p}, {p})",
        (cache_key, json.dumps(analysis_dict)))
    conn.commit()
    conn.close()


def get_cached_analysis(cache_key, max_age_minutes=60):
    conn = get_conn()
    if DATABASE_URL:
        row = _fetchone(conn, """SELECT analysis_json FROM analysis_cache
            WHERE cache_key=%s AND created_at > NOW() - INTERVAL '%s minutes'
            ORDER BY created_at DESC LIMIT 1""", (cache_key, max_age_minutes))
    else:
        row = _fetchone(conn, """SELECT analysis_json FROM analysis_cache
            WHERE cache_key=? AND created_at > datetime('now', ?)
            ORDER BY created_at DESC LIMIT 1""", (cache_key, f"-{max_age_minutes} minutes"))
    conn.close()
    return json.loads(row["analysis_json"]) if row else None


def invalidate_cache():
    conn = get_conn()
    _execute(conn, "DELETE FROM analysis_cache")
    conn.commit()
    conn.close()


# --- transaction cache ---

def cache_transactions(cache_key, transactions, institution_names):
    conn = get_conn()
    p = PH
    _execute(conn, f"DELETE FROM transaction_cache WHERE cache_key = {p}", (cache_key,))
    _execute(conn, f"INSERT INTO transaction_cache (cache_key, transactions_json, institution_names) VALUES ({p},{p},{p})",
        (cache_key, json.dumps(transactions), json.dumps(institution_names)))
    conn.commit()
    conn.close()


def get_cached_transactions(cache_key, max_age_minutes=120):
    conn = get_conn()
    if DATABASE_URL:
        row = _fetchone(conn, """SELECT transactions_json, institution_names FROM transaction_cache
            WHERE cache_key=%s AND created_at > NOW() - INTERVAL '%s minutes'
            ORDER BY created_at DESC LIMIT 1""", (cache_key, max_age_minutes))
    else:
        row = _fetchone(conn, """SELECT transactions_json, institution_names FROM transaction_cache
            WHERE cache_key=? AND created_at > datetime('now', ?)
            ORDER BY created_at DESC LIMIT 1""", (cache_key, f"-{max_age_minutes} minutes"))
    conn.close()
    if row:
        return json.loads(row["transactions_json"]), json.loads(row["institution_names"])
    return None, None


# --- user_settings ---

def get_user_settings():
    conn = get_conn()
    p = PH
    row = _fetchone(conn, f"SELECT * FROM user_settings WHERE id={p}", (1,))
    conn.close()
    if row:
        return {"pet_name": row["pet_name"], "analysis_days": row["analysis_days"]}
    return {"pet_name": "my dog", "analysis_days": 90}


def save_user_settings(pet_name=None, analysis_days=None):
    current = get_user_settings()
    new_name = pet_name if pet_name is not None else current["pet_name"]
    new_days = analysis_days if analysis_days is not None else current["analysis_days"]
    conn = get_conn()
    if DATABASE_URL:
        _execute(conn, """INSERT INTO user_settings (id, pet_name, analysis_days, updated_at)
            VALUES (1, %s, %s, NOW())
            ON CONFLICT (id) DO UPDATE SET pet_name=EXCLUDED.pet_name,
                analysis_days=EXCLUDED.analysis_days, updated_at=NOW()""",
            (new_name, new_days))
    else:
        _execute(conn, """INSERT INTO user_settings (id, pet_name, analysis_days, updated_at)
            VALUES (1, ?, ?, datetime('now'))
            ON CONFLICT(id) DO UPDATE SET pet_name=excluded.pet_name,
                analysis_days=excluded.analysis_days, updated_at=excluded.updated_at""",
            (new_name, new_days))
    conn.commit()
    conn.close()
    return {"pet_name": new_name, "analysis_days": new_days}


# --- cleanup ---

def remove_linked_account(item_id):
    conn = get_conn()
    p = PH
    _execute(conn, f"DELETE FROM accounts WHERE item_id = {p}", (item_id,))
    _execute(conn, f"DELETE FROM linked_accounts WHERE item_id = {p}", (item_id,))
    _execute(conn, "DELETE FROM analysis_cache")
    conn.commit()
    conn.close()


def clear_all_data():
    conn = get_conn()
    _execute(conn, "DELETE FROM linked_accounts")
    _execute(conn, "DELETE FROM accounts")
    _execute(conn, "DELETE FROM analysis_cache")
    _execute(conn, "DELETE FROM transaction_cache")
    conn.commit()
    conn.close()


init_db()
