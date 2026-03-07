import os
import time
import json
from datetime import date, timedelta
from flask import Flask, render_template, request, jsonify
from dotenv import load_dotenv
import plaid as plaid_module

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

import db
import plaid_client
import pet_categorizer

app = Flask(__name__)
app.secret_key = os.getenv("FLASK_SECRET_KEY", "dev")


def _serialize_txn(txn):
    """Convert Plaid transaction to JSON-safe dict."""
    pf = txn.get("personal_finance_category") or {}
    if not isinstance(pf, dict):
        pf = {}
    cat = txn.get("category") or []
    if not isinstance(cat, list):
        cat = [str(cat)]
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
    }


def _get_transactions():
    """Fetch transactions from cache or Plaid. Returns (txns, institution_names) or (None, error_msg)."""
    linked = db.get_all_access_tokens()
    if not linked:
        return None, "No bank connected. Please link your account."

    txn_cache_key = "|".join(sorted(l["item_id"] for l in linked))

    # Check transaction cache first (2 hour TTL)
    cached_txns, cached_insts = db.get_cached_transactions(txn_cache_key)
    if cached_txns is not None:
        return (cached_txns, cached_insts), None

    # Fetch from Plaid
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

    # Cache the raw transactions
    db.cache_transactions(txn_cache_key, all_transactions, institution_names)
    return (all_transactions, institution_names), None


@app.route("/")
def index():
    # Detect subdomain category (e.g., dog.howmuchdidispendon.com)
    host = request.host.split(":")[0]  # strip port
    parts = host.split(".")
    subdomain_category = None
    if len(parts) > 2 and parts[0] not in ("www", ""):
        subdomain_category = parts[0].replace("-", " ")
    return render_template("index.html", plaid_env=os.getenv("PLAID_ENV", "sandbox"),
                           subdomain_category=subdomain_category)


@app.route("/api/create_link_token", methods=["POST"])
def create_link_token():
    try:
        token = plaid_client.create_link_token()
        return jsonify({"link_token": token})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/exchange_token", methods=["POST"])
def exchange_token():
    public_token = request.json.get("public_token")
    if not public_token:
        return jsonify({"error": "Missing public_token"}), 400
    try:
        access_token, item_id = plaid_client.exchange_public_token(public_token)
        institution = request.json.get("institution_name", "Unknown")
        db.save_linked_account(item_id, access_token, institution)

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
        db.upsert_accounts(item_id, accounts_data)
        return jsonify({"success": True, "item_id": item_id})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/prefetch", methods=["POST"])
def prefetch():
    """Pre-fetch and cache transactions right after bank connect. Called async from frontend."""
    result, error = _get_transactions()
    if error:
        return jsonify({"error": error}), 400
    txns, insts = result
    return jsonify({"success": True, "transaction_count": len(txns), "institutions": insts})


@app.route("/api/analysis")
def analysis():
    settings = db.get_user_settings()
    category = request.args.get("category", settings["pet_name"])

    # Check category-specific cache
    linked = db.get_all_access_tokens()
    if not linked:
        return jsonify({"error": "No bank connected. Please link your account."}), 400

    analysis_cache_key = "|".join(sorted(l["item_id"] for l in linked)) + f":{category}"
    cached = db.get_cached_analysis(analysis_cache_key)
    if cached:
        return jsonify(cached)

    # Get transactions (from cache or Plaid)
    result, error = _get_transactions()
    if error:
        return jsonify({"error": error}), 500
    all_transactions, institution_names = result

    # Run Claude categorization (this is the main latency)
    try:
        result = pet_categorizer.analyze_pet_spending(all_transactions, pet_name=category)

        today = date.today()
        d30 = str(today - timedelta(days=30))
        d90 = str(today - timedelta(days=90))

        total_30d = sum(t["amount"] for t in result["transactions"] if t["date"] >= d30)
        total_90d = sum(t["amount"] for t in result["transactions"] if t["date"] >= d90)

        # Detect actual data range
        all_dates = [t["date"] for t in all_transactions if t.get("date")]
        earliest = min(all_dates) if all_dates else str(today)
        days_available = (today - date.fromisoformat(earliest)).days

        result["total_30d"] = round(total_30d, 2)
        result["total_90d"] = round(total_90d, 2)
        result["total_1yr"] = result["total_spent"]
        result["days_available"] = days_available
        result["earliest_date"] = earliest
        result["institutions"] = institution_names
        result["category"] = category

        db.cache_analysis(analysis_cache_key, result)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/institutions")
def institutions():
    linked = db.get_all_access_tokens()
    return jsonify([
        {"item_id": l["item_id"], "institution_name": l.get("institution_name", "Bank")}
        for l in linked
    ])


@app.route("/api/remove_institution", methods=["POST"])
def remove_institution():
    item_id = (request.json or {}).get("item_id")
    if not item_id:
        return jsonify({"error": "Missing item_id"}), 400

    linked = db.get_all_access_tokens()
    access_token = None
    for l in linked:
        if l["item_id"] == item_id:
            access_token = l["access_token"]
            break

    if not access_token:
        return jsonify({"error": "Institution not found"}), 404

    plaid_client.remove_item(access_token)
    db.remove_linked_account(item_id)

    remaining = db.get_all_access_tokens()
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
    db.invalidate_cache()
    return jsonify({"success": True})


@app.route("/privacy")
def privacy():
    return render_template("privacy.html")


@app.route("/api/logout", methods=["POST"])
def logout():
    linked = db.get_all_access_tokens()
    for link in linked:
        try:
            plaid_client.remove_item(link["access_token"])
        except Exception:
            pass
    db.clear_all_data()
    return jsonify({"success": True})


if __name__ == "__main__":
    app.run(debug=True, port=5001)
