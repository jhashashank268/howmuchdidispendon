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


def _safe_alter(conn, table, column, col_type):
    """Idempotent ALTER TABLE ADD COLUMN."""
    try:
        _execute(conn, f"ALTER TABLE {table} ADD COLUMN {column} {col_type}")
    except Exception:
        pass  # column already exists


def init_db():
    conn = get_conn()
    if DATABASE_URL:
        _execute(conn, """
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                google_id TEXT UNIQUE NOT NULL,
                email TEXT,
                name TEXT,
                created_at TIMESTAMP DEFAULT NOW(),
                last_login_at TIMESTAMP DEFAULT NOW()
            )""")
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
        _execute(conn, """
            CREATE TABLE IF NOT EXISTS saved_categories (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                anon_id TEXT,
                category TEXT NOT NULL,
                emoji TEXT,
                last_total REAL,
                previous_total REAL,
                last_analyzed_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT NOW()
            )""")
        # Add user_id/anon_id columns to existing tables
        for table in ("linked_accounts", "accounts", "analysis_cache", "transaction_cache"):
            _safe_alter(conn, table, "user_id", "INTEGER")
            _safe_alter(conn, table, "anon_id", "TEXT")
    else:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                google_id TEXT UNIQUE NOT NULL,
                email TEXT,
                name TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                last_login_at TEXT DEFAULT (datetime('now'))
            );
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
            CREATE TABLE IF NOT EXISTS saved_categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER REFERENCES users(id),
                anon_id TEXT,
                category TEXT NOT NULL,
                emoji TEXT,
                last_total REAL,
                previous_total REAL,
                last_analyzed_at TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            );
        """)
        conn.execute(
            "INSERT OR IGNORE INTO user_settings (id, pet_name, analysis_days) VALUES (1, 'my dog', 90)"
        )
        # Add user_id/anon_id columns to existing tables
        for table in ("linked_accounts", "accounts", "analysis_cache", "transaction_cache"):
            _safe_alter(conn, table, "user_id", "INTEGER")
            _safe_alter(conn, table, "anon_id", "TEXT")
    conn.commit()
    conn.close()


# --- scope helper ---

def _scope_clause(user_id=None, anon_id=None):
    """Return (WHERE clause fragment, params tuple) for scoping queries."""
    if user_id:
        return "user_id = " + PH, (user_id,)
    elif anon_id:
        return "anon_id = " + PH, (anon_id,)
    # Fallback: unscoped (legacy rows with no user_id/anon_id)
    return "(user_id IS NULL AND anon_id IS NULL)", ()


# --- users ---

def upsert_user(google_id, email, name):
    conn = get_conn()
    if DATABASE_URL:
        _execute(conn, """INSERT INTO users (google_id, email, name, last_login_at)
            VALUES (%s, %s, %s, NOW())
            ON CONFLICT (google_id) DO UPDATE SET
                email=EXCLUDED.email, name=EXCLUDED.name, last_login_at=NOW()""",
            (google_id, email, name))
        row = _fetchone(conn, "SELECT id, google_id, email, name FROM users WHERE google_id=%s", (google_id,))
    else:
        _execute(conn, """INSERT INTO users (google_id, email, name, last_login_at)
            VALUES (?, ?, ?, datetime('now'))
            ON CONFLICT(google_id) DO UPDATE SET
                email=excluded.email, name=excluded.name, last_login_at=datetime('now')""",
            (google_id, email, name))
        row = _fetchone(conn, "SELECT id, google_id, email, name FROM users WHERE google_id=?", (google_id,))
    conn.commit()
    conn.close()
    return row


def get_user(user_id):
    conn = get_conn()
    row = _fetchone(conn, f"SELECT id, google_id, email, name FROM users WHERE id={PH}", (user_id,))
    conn.close()
    return row


def claim_anonymous_data(anon_id, user_id):
    """Migrate all anonymous rows to a signed-in user."""
    conn = get_conn()
    for table in ("linked_accounts", "accounts", "analysis_cache", "transaction_cache", "saved_categories"):
        if DATABASE_URL:
            _execute(conn, f"UPDATE {table} SET user_id=%s, anon_id=NULL WHERE anon_id=%s", (user_id, anon_id))
        else:
            _execute(conn, f"UPDATE {table} SET user_id=?, anon_id=NULL WHERE anon_id=?", (user_id, anon_id))
    conn.commit()
    conn.close()


# --- linked_accounts ---

def save_linked_account(item_id, access_token, institution_name=None, user_id=None, anon_id=None):
    conn = get_conn()
    if DATABASE_URL:
        _execute(conn, """INSERT INTO linked_accounts (item_id, access_token, institution_name, user_id, anon_id)
            VALUES (%s, %s, %s, %s, %s) ON CONFLICT (item_id) DO UPDATE SET access_token=EXCLUDED.access_token""",
            (item_id, access_token, institution_name, user_id, anon_id))
    else:
        _execute(conn, """INSERT INTO linked_accounts (item_id, access_token, institution_name, user_id, anon_id)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET access_token=excluded.access_token""",
            (item_id, access_token, institution_name, user_id, anon_id))
    conn.commit()
    conn.close()


def get_all_access_tokens(user_id=None, anon_id=None):
    conn = get_conn()
    clause, params = _scope_clause(user_id, anon_id)
    rows = _fetchall(conn, f"SELECT item_id, access_token, institution_name FROM linked_accounts WHERE {clause} ORDER BY created_at", params)
    if not rows:
        # Fallback: try unscoped legacy rows
        rows = _fetchall(conn, "SELECT item_id, access_token, institution_name FROM linked_accounts WHERE user_id IS NULL AND anon_id IS NULL ORDER BY created_at")
    conn.close()
    return rows


# --- accounts ---

def upsert_accounts(item_id, accounts_data, user_id=None, anon_id=None):
    conn = get_conn()
    for a in accounts_data:
        bal = a.get("balances", {})
        if DATABASE_URL:
            _execute(conn, """INSERT INTO accounts (item_id, account_id, name, type, subtype,
                available_balance, current_balance, updated_at, user_id, anon_id)
                VALUES (%s,%s,%s,%s,%s,%s,%s,NOW(),%s,%s)
                ON CONFLICT (account_id) DO UPDATE SET
                    available_balance=EXCLUDED.available_balance,
                    current_balance=EXCLUDED.current_balance, updated_at=NOW()""",
                (item_id, a["account_id"], a.get("name"), a.get("type"),
                 a.get("subtype"), bal.get("available"), bal.get("current"), user_id, anon_id))
        else:
            _execute(conn, """INSERT INTO accounts (item_id, account_id, name, type, subtype,
                available_balance, current_balance, updated_at, user_id, anon_id)
                VALUES (?,?,?,?,?,?,?,datetime('now'),?,?)
                ON CONFLICT(account_id) DO UPDATE SET
                    available_balance=excluded.available_balance,
                    current_balance=excluded.current_balance, updated_at=excluded.updated_at""",
                (item_id, a["account_id"], a.get("name"), a.get("type"),
                 a.get("subtype"), bal.get("available"), bal.get("current"), user_id, anon_id))
    conn.commit()
    conn.close()


# --- analysis cache ---

def cache_analysis(cache_key, analysis_dict, user_id=None, anon_id=None):
    conn = get_conn()
    p = PH
    _execute(conn, f"DELETE FROM analysis_cache WHERE cache_key = {p}", (cache_key,))
    if DATABASE_URL:
        _execute(conn, f"INSERT INTO analysis_cache (cache_key, analysis_json, user_id, anon_id) VALUES ({p}, {p}, {p}, {p})",
            (cache_key, json.dumps(analysis_dict), user_id, anon_id))
    else:
        _execute(conn, f"INSERT INTO analysis_cache (cache_key, analysis_json, user_id, anon_id) VALUES ({p}, {p}, {p}, {p})",
            (cache_key, json.dumps(analysis_dict), user_id, anon_id))
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


def invalidate_cache(user_id=None, anon_id=None):
    conn = get_conn()
    if user_id or anon_id:
        clause, params = _scope_clause(user_id, anon_id)
        _execute(conn, f"DELETE FROM analysis_cache WHERE {clause}", params)
    else:
        _execute(conn, "DELETE FROM analysis_cache")
    conn.commit()
    conn.close()


# --- transaction cache ---

def cache_transactions(cache_key, transactions, institution_names, user_id=None, anon_id=None):
    conn = get_conn()
    p = PH
    _execute(conn, f"DELETE FROM transaction_cache WHERE cache_key = {p}", (cache_key,))
    _execute(conn, f"INSERT INTO transaction_cache (cache_key, transactions_json, institution_names, user_id, anon_id) VALUES ({p},{p},{p},{p},{p})",
        (cache_key, json.dumps(transactions), json.dumps(institution_names), user_id, anon_id))
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


# --- saved_categories ---

def get_saved_categories(user_id=None, anon_id=None):
    conn = get_conn()
    clause, params = _scope_clause(user_id, anon_id)
    rows = _fetchall(conn, f"SELECT id, category, emoji, last_total, previous_total, last_analyzed_at FROM saved_categories WHERE {clause} ORDER BY last_analyzed_at DESC", params)
    conn.close()
    return rows


def upsert_saved_category(category, emoji, total, user_id=None, anon_id=None):
    conn = get_conn()
    clause, params = _scope_clause(user_id, anon_id)
    existing = _fetchone(conn, f"SELECT id, last_total FROM saved_categories WHERE category={PH} AND {clause}", (category, *params))
    now_expr = "NOW()" if DATABASE_URL else "datetime('now')"
    if existing:
        if DATABASE_URL:
            _execute(conn, f"UPDATE saved_categories SET previous_total=%s, last_total=%s, emoji=%s, last_analyzed_at=NOW() WHERE id=%s",
                (existing["last_total"], total, emoji, existing["id"]))
        else:
            _execute(conn, f"UPDATE saved_categories SET previous_total=?, last_total=?, emoji=?, last_analyzed_at=datetime('now') WHERE id=?",
                (existing["last_total"], total, emoji, existing["id"]))
    else:
        if DATABASE_URL:
            _execute(conn, "INSERT INTO saved_categories (user_id, anon_id, category, emoji, last_total, last_analyzed_at) VALUES (%s,%s,%s,%s,%s,NOW())",
                (user_id, anon_id, category, emoji, total))
        else:
            _execute(conn, "INSERT INTO saved_categories (user_id, anon_id, category, emoji, last_total, last_analyzed_at) VALUES (?,?,?,?,?,datetime('now'))",
                (user_id, anon_id, category, emoji, total))
    conn.commit()
    conn.close()


def delete_saved_category(cat_id, user_id=None, anon_id=None):
    conn = get_conn()
    clause, params = _scope_clause(user_id, anon_id)
    _execute(conn, f"DELETE FROM saved_categories WHERE id={PH} AND {clause}", (cat_id, *params))
    conn.commit()
    conn.close()


# --- cleanup ---

def remove_linked_account(item_id):
    conn = get_conn()
    p = PH
    _execute(conn, f"DELETE FROM accounts WHERE item_id = {p}", (item_id,))
    _execute(conn, f"DELETE FROM linked_accounts WHERE item_id = {p}", (item_id,))
    _execute(conn, "DELETE FROM analysis_cache")
    conn.commit()
    conn.close()


def clear_all_data(user_id=None, anon_id=None):
    conn = get_conn()
    if user_id or anon_id:
        clause, params = _scope_clause(user_id, anon_id)
        for table in ("linked_accounts", "accounts", "analysis_cache", "transaction_cache", "saved_categories"):
            _execute(conn, f"DELETE FROM {table} WHERE {clause}", params)
    else:
        _execute(conn, "DELETE FROM linked_accounts")
        _execute(conn, "DELETE FROM accounts")
        _execute(conn, "DELETE FROM analysis_cache")
        _execute(conn, "DELETE FROM transaction_cache")
        _execute(conn, "DELETE FROM saved_categories")
    conn.commit()
    conn.close()


init_db()
