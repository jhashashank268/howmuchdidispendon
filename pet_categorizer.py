"""
Spending categorizer using Claude API.
Analyzes bank transactions to identify spending in any user-defined category.
"""

import os
import anthropic
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))

# Max transactions to send to Claude in a single batch
BATCH_SIZE = 200


def _serialize_txn(i, txn):
    """Safely serialize a transaction for the Claude prompt."""
    name = txn.get("name") or txn.get("merchant_name") or "Unknown"
    amount = abs(txn.get("amount", 0))
    date = str(txn.get("date", ""))
    merchant = txn.get("merchant_name") or ""
    category = txn.get("category") or []
    if not isinstance(category, list):
        category = [str(category)]
    pf = txn.get("personal_finance_category") or {}
    if not isinstance(pf, dict):
        pf = {}
    loc = txn.get("location") or {}
    if not isinstance(loc, dict):
        loc = {}
    loc_parts = [loc.get("city", ""), loc.get("region", ""), loc.get("country", "")]
    loc_str = ",".join(p for p in loc_parts if p)
    return f"{i}|{date}|{name}|{merchant}|${amount:.2f}|{','.join(str(c) for c in category)}|{pf.get('detailed', '')}|{loc_str}"


def categorize_with_claude(transactions, spending_category="dog"):
    """
    Use Claude to identify transactions related to a spending category.
    Works for any category: dog, groceries, coffee, rent, restaurants, uber, etc.
    """
    if not transactions:
        return [], None

    # Build transaction block
    txn_lines = [_serialize_txn(i, txn) for i, txn in enumerate(transactions)]
    txn_block = "\n".join(txn_lines)

    prompt = f"""You are analyzing bank transactions to find all spending related to: "{spending_category}"

For EACH transaction, output one line:
index|match|subcategory|confidence

- match: yes or no
- subcategory: a short label for the type of "{spending_category}" expense (e.g. for "dog": "food", "vet", "grooming"; for "groceries": "supermarket", "organic"; for "coffee": "coffee shop", "beans"; etc.)
- confidence: high, medium, or low

Transactions (index|date|name|merchant|amount|plaid_category|pf_detail|location):
{txn_block}

CRITICAL RULES:
1. The "pf_detail" column is Plaid's detailed financial category — this is the MOST RELIABLE signal. Trust it heavily.
   Examples: FOOD_AND_DRINK_COFFEE, FOOD_AND_DRINK_GROCERIES, TRANSPORTATION_RIDESHARE, PETS_VETERINARY, etc.
2. Use the merchant name AND pf_detail together. If pf_detail says "FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR" do NOT classify it as groceries or clothing.
3. A liquor store is NOT clothing. A gas station is NOT groceries (unless pf_detail says so). Stay precise.
4. For specific brands (e.g. "uber", "starbucks"), match that exact brand plus directly related competitors.
5. For broad categories (e.g. "groceries", "restaurants"), match all relevant merchants but respect the pf_detail category.
6. Only output "yes" if you are genuinely confident this transaction belongs to "{spending_category}".
7. When unsure, mark confidence as "low" — do NOT guess.
8. LOCATION QUERIES: If the spending category is a place name (city, state, country like "San Francisco", "India", "Fremont"), match ONLY based on the "location" column data (city, region, country). Do NOT guess location from merchant names — a store named "Delhi Grocery" is NOT necessarily in India. Only use the actual location data provided.
9. FIRST LINE: Output a single emoji that best represents the spending category "{spending_category}" (e.g. 🚗 for Tesla, ☕ for coffee, 🐕 for dog, 🇮🇳 for India, 🌉 for San Francisco). Format: EMOJI|<emoji>
10. Then output the transaction lines. Output ONLY the formatted lines, nothing else."""

    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=8192,
        messages=[{"role": "user", "content": prompt}],
    )

    results = []
    suggested_emoji = None
    response_text = response.content[0].text.strip()

    for line in response_text.split("\n"):
        line = line.strip()
        if not line or "|" not in line:
            continue
        # Extract emoji suggestion from first EMOJI| line
        if line.startswith("EMOJI|"):
            suggested_emoji = line.split("|", 1)[1].strip()
            continue
        parts = line.split("|")
        if len(parts) < 4:
            continue
        try:
            idx = int(parts[0])
            is_match = parts[1].strip().lower() == "yes"
            subcategory = parts[2].strip()
            confidence = parts[3].strip().lower()

            if is_match and 0 <= idx < len(transactions):
                txn = transactions[idx]
                results.append({
                    "transaction_id": txn.get("transaction_id", f"txn_{idx}"),
                    "date": str(txn.get("date", "")),
                    "name": txn.get("name") or txn.get("merchant_name") or "Unknown",
                    "merchant_name": txn.get("merchant_name") or "",
                    "amount": abs(txn.get("amount", 0)),
                    "category": subcategory.lower().replace(" ", "_"),
                    "category_label": subcategory.title(),
                    "confidence": confidence if confidence in ("high", "medium", "low") else "medium",
                })
        except (ValueError, IndexError):
            continue

    return results, suggested_emoji


def analyze_pet_spending(transactions, pet_name="dog"):
    """
    Full analysis: send all transactions to Claude in batches, aggregate results.
    Works for any spending category despite the function name (kept for API compat).
    """
    all_results = []
    emoji = None

    # Process in batches
    for start in range(0, len(transactions), BATCH_SIZE):
        batch = transactions[start:start + BATCH_SIZE]
        batch_results, batch_emoji = categorize_with_claude(batch, pet_name)
        if batch_emoji and not emoji:
            emoji = batch_emoji
        all_results.extend(batch_results)

    # Calculate totals
    total_spent = sum(t["amount"] for t in all_results)

    # Category breakdown
    by_category = {}
    for t in all_results:
        label = t["category_label"]
        if label not in by_category:
            by_category[label] = {"label": label, "total": 0, "count": 0, "transactions": []}
        by_category[label]["total"] += t["amount"]
        by_category[label]["count"] += 1
        by_category[label]["transactions"].append(t)

    sorted_categories = sorted(by_category.values(), key=lambda x: x["total"], reverse=True)

    return {
        "total_spent": round(total_spent, 2),
        "transaction_count": len(all_results),
        "total_transactions_analyzed": len(transactions),
        "categories": sorted_categories,
        "transactions": sorted(all_results, key=lambda x: x["date"], reverse=True),
        "pet_name": pet_name,
        "emoji": emoji,
    }
