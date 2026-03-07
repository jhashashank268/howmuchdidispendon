import os
from dotenv import load_dotenv
import plaid
from plaid.api import plaid_api
from plaid.model.products import Products
from plaid.model.country_code import CountryCode
from plaid.model.link_token_create_request import LinkTokenCreateRequest
from plaid.model.link_token_create_request_user import LinkTokenCreateRequestUser
from plaid.model.item_public_token_exchange_request import ItemPublicTokenExchangeRequest
from plaid.model.accounts_get_request import AccountsGetRequest
from plaid.model.accounts_balance_get_request import AccountsBalanceGetRequest
from plaid.model.transactions_get_request import TransactionsGetRequest
from plaid.model.transactions_get_request_options import TransactionsGetRequestOptions
from plaid.model.transactions_recurring_get_request import TransactionsRecurringGetRequest
from plaid.model.liabilities_get_request import LiabilitiesGetRequest
from plaid.model.investments_holdings_get_request import InvestmentsHoldingsGetRequest
from plaid.model.credit_bank_income_get_request import CreditBankIncomeGetRequest
from plaid.model.signal_evaluate_request import SignalEvaluateRequest
from plaid.model.transfer_authorization_create_request import TransferAuthorizationCreateRequest
from plaid.model.transfer_create_request import TransferCreateRequest
from plaid.model.transfer_get_request import TransferGetRequest
from plaid.model.transfer_list_request import TransferListRequest
from plaid.model.transfer_type import TransferType
from plaid.model.transfer_network import TransferNetwork
from plaid.model.ach_class import ACHClass
from plaid.model.transfer_user_in_request import TransferUserInRequest
from datetime import date, timedelta

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

PLAID_CLIENT_ID = os.getenv("PLAID_CLIENT_ID")
PLAID_SECRET = os.getenv("PLAID_SECRET")
PLAID_ENV = os.getenv("PLAID_ENV", "sandbox")

ENV_MAP = {
    "sandbox": plaid.Environment.Sandbox,
    "production": plaid.Environment.Production,
}

configuration = plaid.Configuration(
    host=ENV_MAP.get(PLAID_ENV, plaid.Environment.Sandbox),
    api_key={"clientId": PLAID_CLIENT_ID, "secret": PLAID_SECRET},
)
api_client = plaid.ApiClient(configuration)
client = plaid_api.PlaidApi(api_client)


def create_link_token():
    request = LinkTokenCreateRequest(
        products=[Products("transactions")],
        additional_consented_products=[
            Products("liabilities"),
            Products("investments"),
        ],
        client_name="How Much Did I Spend",
        country_codes=[CountryCode("US")],
        language="en",
        user=LinkTokenCreateRequestUser(client_user_id="user-1"),
    )
    response = client.link_token_create(request)
    return response.to_dict()["link_token"]


def remove_item(access_token):
    """Remove an Item (revoke access token) from Plaid."""
    try:
        from plaid.model.item_remove_request import ItemRemoveRequest
        request = ItemRemoveRequest(access_token=access_token)
        client.item_remove(request)
        return True
    except plaid.ApiException:
        return False


def exchange_public_token(public_token):
    request = ItemPublicTokenExchangeRequest(public_token=public_token)
    response = client.item_public_token_exchange(request)
    data = response.to_dict()
    return data["access_token"], data["item_id"]


def get_accounts(access_token):
    request = AccountsGetRequest(access_token=access_token)
    response = client.accounts_get(request)
    data = response.to_dict()
    return data["accounts"]


def get_realtime_balance(access_token):
    """Fetch real-time balances (forces live fetch, not cached)."""
    try:
        request = AccountsBalanceGetRequest(access_token=access_token)
        response = client.accounts_balance_get(request)
        data = response.to_dict()
        return data["accounts"]
    except plaid.ApiException:
        return None


def get_transactions(access_token, days=90):
    start = date.today() - timedelta(days=days)
    end = date.today()
    request = TransactionsGetRequest(
        access_token=access_token,
        start_date=start,
        end_date=end,
        options=TransactionsGetRequestOptions(count=500, offset=0),
    )
    response = client.transactions_get(request)
    data = response.to_dict()
    txns = data["transactions"]

    # Paginate if needed
    total = data["total_transactions"]
    while len(txns) < total:
        request = TransactionsGetRequest(
            access_token=access_token,
            start_date=start,
            end_date=end,
            options=TransactionsGetRequestOptions(count=500, offset=len(txns)),
        )
        response = client.transactions_get(request)
        txns.extend(response.to_dict()["transactions"])

    return txns


def get_recurring_transactions(access_token):
    request = TransactionsRecurringGetRequest(access_token=access_token)
    response = client.transactions_recurring_get(request)
    data = response.to_dict()
    return data.get("outflow_streams", []), data.get("inflow_streams", [])


def get_liabilities(access_token):
    try:
        request = LiabilitiesGetRequest(access_token=access_token)
        response = client.liabilities_get(request)
        return response.to_dict().get("liabilities", {})
    except plaid.ApiException:
        return {}


# --- NEW: Investments ---

def get_investments(access_token):
    """Fetch investment holdings and securities."""
    try:
        request = InvestmentsHoldingsGetRequest(access_token=access_token)
        response = client.investments_holdings_get(request)
        data = response.to_dict()
        return {
            "accounts": data.get("accounts", []),
            "holdings": data.get("holdings", []),
            "securities": data.get("securities", []),
        }
    except plaid.ApiException:
        return None


# --- NEW: Income ---

def get_income(access_token):
    """Fetch bank income data (verified employer, pay frequency, amounts)."""
    try:
        request = CreditBankIncomeGetRequest(
            user_token=None,
        )
        response = client.credit_bank_income_get(request)
        data = response.to_dict()
        return data.get("bank_income", [])
    except plaid.ApiException:
        return None


# --- NEW: Signal (pre-flight risk check) ---

def evaluate_signal(access_token, account_id, amount):
    """Evaluate ACH transfer risk. Returns score (1-99) + recommendation."""
    try:
        request = SignalEvaluateRequest(
            access_token=access_token,
            account_id=account_id,
            client_transaction_id=f"sweep-{account_id}-{int(amount*100)}",
            amount=amount,
        )
        response = client.signal_evaluate(request)
        data = response.to_dict()
        scores = data.get("scores", {})
        overall = scores.get("customer_initiated_return_risk", {})
        return {
            "score": overall.get("score", 50),
            "risk_tier": overall.get("risk_tier", "MEDIUM"),
            "recommendation": _signal_recommendation(overall.get("score", 50)),
        }
    except plaid.ApiException:
        return {"score": 50, "risk_tier": "UNKNOWN", "recommendation": "warn"}


def _signal_recommendation(score):
    if score < 50:
        return "proceed"
    elif score <= 80:
        return "warn"
    else:
        return "block"


# --- NEW: Transfer (ACH sweep execution) ---

def create_transfer(access_token, account_id, amount, description="Sweep to savings"):
    """Initiate an ACH debit transfer."""
    try:
        # Step 1: Authorize
        auth_request = TransferAuthorizationCreateRequest(
            access_token=access_token,
            account_id=account_id,
            type=TransferType("debit"),
            network=TransferNetwork("ach"),
            amount=str(round(amount, 2)),
            ach_class=ACHClass("ppd"),
            user=TransferUserInRequest(legal_name="Sweep User"),
        )
        auth_response = client.transfer_authorization_create(auth_request)
        auth_data = auth_response.to_dict()
        authorization_id = auth_data["authorization"]["id"]

        # Step 2: Create transfer
        create_request = TransferCreateRequest(
            access_token=access_token,
            account_id=account_id,
            authorization_id=authorization_id,
            description=description,
        )
        create_response = client.transfer_create(create_request)
        transfer_data = create_response.to_dict()
        transfer = transfer_data["transfer"]
        return {
            "transfer_id": transfer["id"],
            "amount": float(transfer["amount"]),
            "status": transfer["status"],
            "created": transfer.get("created"),
        }
    except plaid.ApiException as e:
        return {"error": str(e)}


def get_transfer(transfer_id):
    """Check status of a specific transfer."""
    try:
        request = TransferGetRequest(transfer_id=transfer_id)
        response = client.transfer_get(request)
        data = response.to_dict()
        transfer = data["transfer"]
        return {
            "transfer_id": transfer["id"],
            "amount": float(transfer["amount"]),
            "status": transfer["status"],
            "created": transfer.get("created"),
        }
    except plaid.ApiException:
        return None


def list_transfers():
    """List all transfers for audit trail."""
    try:
        request = TransferListRequest()
        response = client.transfer_list(request)
        data = response.to_dict()
        return [
            {
                "transfer_id": t["id"],
                "amount": float(t["amount"]),
                "status": t["status"],
                "created": t.get("created"),
            }
            for t in data.get("transfers", [])
        ]
    except plaid.ApiException:
        return []
