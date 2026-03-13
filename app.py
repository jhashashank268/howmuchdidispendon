import os
import time
import json
import uuid
import threading
from datetime import date, timedelta
from flask import Flask, render_template, request, jsonify, session
from dotenv import load_dotenv
import plaid as plaid_module

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

import db
import plaid_client
import pet_categorizer

app = Flask(__name__)
app.secret_key = os.getenv("FLASK_SECRET_KEY", "dev")

GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")

CATEGORIES = [
    {"key": "dog", "emoji": "\U0001f436"},
    {"key": "groceries", "emoji": "\U0001f6d2"},
    {"key": "coffee", "emoji": "\u2615"},
    {"key": "restaurants", "emoji": "\U0001f37d\ufe0f"},
    {"key": "rent", "emoji": "\U0001f3e0"},
    {"key": "clothes", "emoji": "\U0001f455"},
    {"key": "rideshare", "emoji": "\U0001f697"},
    {"key": "subscriptions", "emoji": "\U0001f4f1"},
    {"key": "travel", "emoji": "\u2708\ufe0f"},
    {"key": "fitness", "emoji": "\U0001f4aa"},
    {"key": "fast food", "emoji": "\U0001f35f"},
    {"key": "alcohol", "emoji": "\U0001f377"},
    {"key": "hawaii", "emoji": "\U0001f308"},
    {"key": "san francisco", "emoji": "\U0001f309"},
]

# Track prefetch progress per scope key
_prefetch_status = {}


def _get_scope():
    """Return (user_id, anon_id) from session."""
    user_id = session.get("user_id")
    if user_id:
        return user_id, None
    anon_id = session.get("anon_id")
    if not anon_id:
        anon_id = str(uuid.uuid4())
        session["anon_id"] = anon_id
    return None, anon_id


def _scope_key():
    """A string key for identifying the current scope (for cache keys, prefetch tracking)."""
    uid, aid = _get_scope()
    return f"u:{uid}" if uid else f"a:{aid}"


def _serialize_txn(txn):
    """Convert Plaid transaction to JSON-safe dict."""
    pf = txn.get("personal_finance_category") or {}
    if not isinstance(pf, dict):
        pf = {}
    cat = txn.get("category") or []
    if not isinstance(cat, list):
        cat = [str(cat)]
    loc = txn.get("location") or {}
    if not isinstance(loc, dict):
        loc = {}
    return {
        "transaction_id": txn.get("transaction_id", ""),
        "date": str(txn.get("date", "")),
        "name": txn.get("name") or "",
        "merchant_name": txn.get("merchant_name") or "",
        "amount": txn.get("amount", 0),
        "category": cat,
        "personal_finance_category": {
            "primary": str(pf.get("primary") or ""),
            "detailed": str(pf.get("detailed") or ""),
        },
        "location": {
            "city": str(loc.get("city") or ""),
            "region": str(loc.get("region") or ""),
            "country": str(loc.get("country") or ""),
        },
    }


def _get_transactions(user_id=None, anon_id=None):
    """Fetch transactions from cache or Plaid. Returns (txns, institution_names) or (None, error_msg)."""
    linked = db.get_all_access_tokens(user_id=user_id, anon_id=anon_id)
    if not linked:
        return None, "No bank connected. Please link your account."

    txn_cache_key = "|".join(sorted(l["item_id"] for l in linked))

    cached_txns, cached_insts = db.get_cached_transactions(txn_cache_key)
    if cached_txns is not None:
        return (cached_txns, cached_insts), None

    all_transactions = []
    institution_names = []

    for link in linked:
        access_token = link["access_token"]
        inst_name = link.get("institution_name", "Bank")
        institution_names.append(inst_name)

        max_retries = 5
        for attempt in range(max_retries):
            try:
                transactions = plaid_client.get_transactions(access_token, days=365)
                all_transactions.extend([_serialize_txn(t) for t in transactions])
                break
            except plaid_module.ApiException as e:
                if "PRODUCT_NOT_READY" in str(e) and attempt < max_retries - 1:
                    time.sleep(3)
                    continue
                print(f"Warning: Failed to fetch from {inst_name}: {e}")
                break
            except Exception as e:
                print(f"Warning: Failed to fetch from {inst_name}: {e}")
                break

    if not all_transactions:
        return None, "No transactions found. Try reconnecting your bank."

    db.cache_transactions(txn_cache_key, all_transactions, institution_names, user_id=user_id, anon_id=anon_id)
    return (all_transactions, institution_names), None


def _run_single_analysis(all_transactions, institution_names, category, linked, user_id=None, anon_id=None):
    """Run analysis for a single category and cache it. Returns the result dict."""
    analysis_cache_key = "|".join(sorted(l["item_id"] for l in linked)) + f":{category}"
    cached = db.get_cached_analysis(analysis_cache_key)
    if cached:
        return cached

    result = pet_categorizer.analyze_pet_spending(all_transactions, pet_name=category)

    today = date.today()
    d30 = str(today - timedelta(days=30))
    d60 = str(today - timedelta(days=60))
    d90 = str(today - timedelta(days=90))

    total_30d = sum(t["amount"] for t in result["transactions"] if t["date"] >= d30)
    prior_30d = sum(t["amount"] for t in result["transactions"] if d60 <= t["date"] < d30)
    total_90d = sum(t["amount"] for t in result["transactions"] if t["date"] >= d90)

    all_dates = [t["date"] for t in all_transactions if t.get("date")]
    earliest = min(all_dates) if all_dates else str(today)
    days_available = (today - date.fromisoformat(earliest)).days

    result["total_30d"] = round(total_30d, 2)
    result["prior_30d"] = round(prior_30d, 2)
    result["total_90d"] = round(total_90d, 2)
    result["total_1yr"] = result["total_spent"]
    result["days_available"] = days_available
    result["earliest_date"] = earliest
    result["institutions"] = institution_names
    result["category"] = category

    db.cache_analysis(analysis_cache_key, result, user_id=user_id, anon_id=anon_id)

    return result


def _prefetch_all_categories(user_id, anon_id):
    """Background job: analyze all 12 preset categories."""
    scope_key = f"u:{user_id}" if user_id else f"a:{anon_id}"
    _prefetch_status[scope_key] = {"total": len(CATEGORIES), "done": 0, "categories": []}

    result, error = _get_transactions(user_id=user_id, anon_id=anon_id)
    if error:
        _prefetch_status[scope_key]["error"] = error
        return

    all_transactions, institution_names = result
    linked = db.get_all_access_tokens(user_id=user_id, anon_id=anon_id)

    for cat in CATEGORIES:
        try:
            _run_single_analysis(all_transactions, institution_names, cat["key"], linked, user_id=user_id, anon_id=anon_id)
        except Exception as e:
            print(f"Prefetch error for {cat['key']}: {e}")
        _prefetch_status[scope_key]["done"] += 1
        _prefetch_status[scope_key]["categories"].append(cat["key"])

    _prefetch_status[scope_key]["complete"] = True


# --- Routes ---

@app.route("/")
def index():
    host = request.host.split(":")[0]
    parts = host.split(".")
    subdomain_category = None
    if len(parts) > 2 and parts[0] not in ("www", ""):
        subdomain_category = parts[0].replace("-", " ")
    return render_template("index.html", plaid_env=os.getenv("PLAID_ENV", "sandbox"),
                           subdomain_category=subdomain_category,
                           google_client_id=GOOGLE_CLIENT_ID)


# --- Auth routes ---

@app.route("/api/auth/google", methods=["POST"])
def auth_google():
    credential = (request.json or {}).get("credential")
    if not credential:
        return jsonify({"error": "Missing credential"}), 400

    try:
        from google.oauth2 import id_token
        from google.auth.transport import requests as google_requests
        idinfo = id_token.verify_oauth2_token(credential, google_requests.Request(), GOOGLE_CLIENT_ID)
        google_id = idinfo["sub"]
        email = idinfo.get("email", "")
        name = idinfo.get("name", "")
    except Exception as e:
        return jsonify({"error": f"Invalid credential: {e}"}), 401

    # Check if new signup vs returning login
    existing = db.get_user_by_google_id(google_id)
    user = db.upsert_user(google_id, email, name)
    if not existing:
        db.log_event("user_signup", {"email_domain": email.split("@")[-1] if email else ""}, user_id=user["id"])
    db.log_event("user_login", {}, user_id=user["id"])
    old_anon_id = session.get("anon_id")
    session["user_id"] = user["id"]
    session.pop("anon_id", None)

    # Claim anonymous data
    if old_anon_id:
        db.claim_anonymous_data(old_anon_id, user["id"])

    return jsonify({"user": {"id": user["id"], "name": user["name"], "email": user["email"]}})


@app.route("/api/auth/signout", methods=["POST"])
def auth_signout():
    session.pop("user_id", None)
    return jsonify({"success": True})


@app.route("/api/auth/me")
def auth_me():
    user_id = session.get("user_id")
    if user_id:
        user = db.get_user(user_id)
        if user:
            return jsonify({"authenticated": True, "user": {"id": user["id"], "name": user["name"], "email": user["email"]}})
    return jsonify({"authenticated": False})


# --- Plaid routes ---

@app.route("/api/create_link_token", methods=["POST"])
def create_link_token():
    try:
        uid, aid = _get_scope()
        client_user_id = f"user-{uid}" if uid else f"anon-{aid}"
        token = plaid_client.create_link_token(client_user_id=client_user_id)
        return jsonify({"link_token": token})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/exchange_token", methods=["POST"])
def exchange_token():
    public_token = request.json.get("public_token")
    if not public_token:
        return jsonify({"error": "Missing public_token"}), 400
    try:
        uid, aid = _get_scope()
        access_token, item_id = plaid_client.exchange_public_token(public_token)
        institution = request.json.get("institution_name", "Unknown")
        db.save_linked_account(item_id, access_token, institution, user_id=uid, anon_id=aid)

        accounts = plaid_client.get_accounts(access_token)
        accounts_data = []
        for a in accounts:
            accounts_data.append({
                "account_id": a["account_id"],
                "name": a.get("name"),
                "type": a.get("type"),
                "subtype": a.get("subtype"),
                "balances": a.get("balances", {}),
            })
        db.upsert_accounts(item_id, accounts_data, user_id=uid, anon_id=aid)
        db.log_event("bank_connected", {"institution": institution}, user_id=uid, anon_id=aid)
        return jsonify({"success": True, "item_id": item_id})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/prefetch", methods=["POST"])
def prefetch():
    uid, aid = _get_scope()
    result, error = _get_transactions(user_id=uid, anon_id=aid)
    if error:
        return jsonify({"error": error}), 400
    txns, insts = result
    return jsonify({"success": True, "transaction_count": len(txns), "institutions": insts})


@app.route("/api/prefetch_all", methods=["POST"])
def prefetch_all():
    """Trigger background analysis of all 12 preset categories."""
    uid, aid = _get_scope()
    thread = threading.Thread(target=_prefetch_all_categories, args=(uid, aid), daemon=True)
    thread.start()
    return jsonify({"success": True, "message": "Prefetch started"})


@app.route("/api/prefetch_status")
def prefetch_status():
    """Return which categories have been pre-analyzed so far."""
    sk = _scope_key()
    status = _prefetch_status.get(sk, {"total": len(CATEGORIES), "done": 0, "categories": [], "complete": False})
    return jsonify(status)


@app.route("/api/analysis")
def analysis():
    settings = db.get_user_settings()
    category = request.args.get("category", settings["pet_name"])
    uid, aid = _get_scope()

    linked = db.get_all_access_tokens(user_id=uid, anon_id=aid)
    if not linked:
        return jsonify({"error": "No bank connected. Please link your account."}), 400

    is_preset = any(c["key"] == category for c in CATEGORIES)
    db.log_event("search", {"category": category, "is_preset": is_preset}, user_id=uid, anon_id=aid)

    analysis_cache_key = "|".join(sorted(l["item_id"] for l in linked)) + f":{category}"
    cached = db.get_cached_analysis(analysis_cache_key)
    if cached:
        return jsonify(cached)

    result, error = _get_transactions(user_id=uid, anon_id=aid)
    if error:
        return jsonify({"error": error}), 500
    all_transactions, institution_names = result

    try:
        analysis_result = _run_single_analysis(all_transactions, institution_names, category, linked, user_id=uid, anon_id=aid)
        return jsonify(analysis_result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/institutions")
def institutions():
    uid, aid = _get_scope()
    linked = db.get_all_access_tokens(user_id=uid, anon_id=aid)
    return jsonify([
        {"item_id": l["item_id"], "institution_name": l.get("institution_name", "Bank")}
        for l in linked
    ])


@app.route("/api/remove_institution", methods=["POST"])
def remove_institution():
    item_id = (request.json or {}).get("item_id")
    if not item_id:
        return jsonify({"error": "Missing item_id"}), 400

    uid, aid = _get_scope()
    linked = db.get_all_access_tokens(user_id=uid, anon_id=aid)
    access_token = None
    for l in linked:
        if l["item_id"] == item_id:
            access_token = l["access_token"]
            break

    if not access_token:
        return jsonify({"error": "Institution not found"}), 404

    plaid_client.remove_item(access_token)
    db.remove_linked_account(item_id)
    db.log_event("bank_removed", {"item_id": item_id}, user_id=uid, anon_id=aid)

    remaining = db.get_all_access_tokens(user_id=uid, anon_id=aid)
    return jsonify({"success": True, "remaining": len(remaining)})


@app.route("/api/settings", methods=["GET", "POST"])
def settings():
    if request.method == "GET":
        return jsonify(db.get_user_settings())

    data = request.json or {}
    result = db.save_user_settings(
        pet_name=data.get("pet_name"),
        analysis_days=data.get("analysis_days"),
    )
    return jsonify(result)


@app.route("/api/refresh", methods=["POST"])
def refresh():
    uid, aid = _get_scope()
    db.invalidate_cache(user_id=uid, anon_id=aid)
    return jsonify({"success": True})


# --- Saved categories ---

@app.route("/api/saved_categories")
def saved_categories_list():
    uid, aid = _get_scope()
    cats = db.get_saved_categories(user_id=uid, anon_id=aid)
    return jsonify(cats)


@app.route("/api/saved_categories", methods=["POST"])
def saved_categories_create():
    data = request.json or {}
    category = data.get("category", "").strip()
    if not category:
        return jsonify({"error": "Missing category"}), 400
    emoji = data.get("emoji")
    total = data.get("total")
    uid, aid = _get_scope()
    db.upsert_saved_category(category, emoji, total, user_id=uid, anon_id=aid)
    db.log_event("category_saved", {"category": category}, user_id=uid, anon_id=aid)
    return jsonify({"success": True})


@app.route("/api/saved_categories/<int:cat_id>", methods=["DELETE"])
def saved_categories_delete(cat_id):
    uid, aid = _get_scope()
    db.delete_saved_category(cat_id, user_id=uid, anon_id=aid)
    return jsonify({"success": True})


@app.route("/api/spending_summary")
def spending_summary():
    """Lightweight summary: total expenses and transaction count from cached data."""
    uid, aid = _get_scope()
    linked = db.get_all_access_tokens(user_id=uid, anon_id=aid)
    if not linked:
        return jsonify({"total": 0, "count": 0})
    txn_cache_key = "|".join(sorted(l["item_id"] for l in linked))
    # Use relaxed 24-hour TTL — summary doesn't need real-time data
    cached_txns, _ = db.get_cached_transactions(txn_cache_key, max_age_minutes=1440)
    if not cached_txns:
        # No cached data at all — try a fresh Plaid fetch
        result, error = _get_transactions(user_id=uid, anon_id=aid)
        if error:
            return jsonify({"total": 0, "count": 0})
        cached_txns, _ = result
    # Plaid: positive amount = money out (expense)
    expenses = [t for t in cached_txns if t.get("amount", 0) > 0]
    total = sum(t["amount"] for t in expenses)
    return jsonify({"total": round(total, 2), "count": len(expenses)})


@app.route("/api/analytics")
def analytics():
    """Simple analytics dashboard endpoint."""
    return jsonify(db.get_events_summary())


@app.route("/api/debug/location_sample")
def debug_location_sample():
    """Show a sample of transactions with their location data to verify Plaid provides it."""
    uid, aid = _get_scope()
    # Force fresh fetch (skip cache) to see raw Plaid location data
    linked = db.get_all_access_tokens(user_id=uid, anon_id=aid)
    if not linked:
        return jsonify({"error": "No bank connected"}), 400
    try:
        access_token = linked[0]["access_token"]
        transactions = plaid_client.get_transactions(access_token, days=90)
        sample = []
        for t in transactions[:50]:
            loc = t.get("location") or {}
            if not isinstance(loc, dict):
                loc = {}
            sample.append({
                "name": t.get("name") or "",
                "merchant_name": t.get("merchant_name") or "",
                "amount": t.get("amount", 0),
                "date": str(t.get("date", "")),
                "location": {
                    "city": loc.get("city") or "",
                    "region": loc.get("region") or "",
                    "country": loc.get("country") or "",
                    "address": loc.get("address") or "",
                    "postal_code": loc.get("postal_code") or "",
                    "lat": loc.get("lat"),
                    "lon": loc.get("lon"),
                },
            })
        has_location = sum(1 for s in sample if s["location"]["city"])
        return jsonify({
            "total_sampled": len(sample),
            "with_city": has_location,
            "without_city": len(sample) - has_location,
            "transactions": sample,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/privacy")
def privacy():
    return render_template("privacy.html")


@app.route("/api/logout", methods=["POST"])
def logout():
    uid, aid = _get_scope()
    linked = db.get_all_access_tokens(user_id=uid, anon_id=aid)
    for link in linked:
        try:
            plaid_client.remove_item(link["access_token"])
        except Exception:
            pass
    db.clear_all_data(user_id=uid, anon_id=aid)
    session.pop("user_id", None)
    session.pop("anon_id", None)
    return jsonify({"success": True})


if __name__ == "__main__":
    app.run(debug=True, port=5001)
