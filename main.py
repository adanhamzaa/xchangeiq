# main.py

import csv
import io
import os
import re
from typing import Any, Dict, List, Optional, Tuple

import requests
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import PlainTextResponse

app = FastAPI(title="XchangeIQ WhatsApp Webhook")

GOOGLE_SHEET_CSV_URL = (
    "https://docs.google.com/spreadsheets/d/e/"
    "2PACX-1vQbnna-vcEFstuBQvVLP1bFLEveKMrJ1DAeWzVjHKi_WAJnDvJzg4KTlWWYNOcc8hffAayMBLYgYLoR/"
    "pub?gid=0&single=true&output=csv"
)

VERIFY_TOKEN = os.environ.get("VERIFY_TOKEN", "")
WHATSAPP_TOKEN = os.environ.get("WHATSAPP_TOKEN", "")
PHONE_NUMBER_ID = os.environ.get("PHONE_NUMBER_ID", "")
GRAPH_API_VERSION = os.environ.get("GRAPH_API_VERSION", "v23.0")

PROCESSED_MESSAGE_IDS = set()


def read_rates_from_csv() -> List[Dict[str, str]]:
    response = requests.get(GOOGLE_SHEET_CSV_URL, timeout=20)
    response.raise_for_status()

    csv_text = response.content.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(csv_text))

    rows = []

    for row in reader:
        cleaned_row = {}

        for key, value in row.items():
            if key is not None:
                cleaned_row[key.strip().lower().replace(" ", "_")] = (
                    str(value or "").strip()
                )

        if any(cleaned_row.values()):
            rows.append(cleaned_row)

    return rows


def parse_amount(text: str) -> Optional[float]:
    cleaned_text = text.lower().replace(",", "")

    match = re.search(
        r"(?<![a-z])(\d+(?:\.\d+)?)\s*(k|thousand|m|million)?(?![a-z])",
        cleaned_text,
    )

    if not match:
        return None

    amount = float(match.group(1))
    suffix = match.group(2)

    if suffix in ("k", "thousand"):
        amount *= 1_000
    elif suffix in ("m", "million"):
        amount *= 1_000_000

    return amount if amount > 0 else None


def parse_message(text: str) -> Dict[str, Any]:
    lowered = text.lower()

    currency_aliases = {
        "USD": [
            "usd",
            "dollar",
            "dollars",
            "us dollar",
            "us dollars",
        ],
        "EUR": [
            "eur",
            "euro",
            "euros",
        ],
        "GBP": [
            "gbp",
            "pound",
            "pounds",
            "sterling",
        ],
        "TZS": [
            "tzs",
            "tanzania shilling",
            "tanzania shillings",
        ],
        "UGX": [
            "ugx",
            "uganda shilling",
            "uganda shillings",
        ],
        "RWF": [
            "rwf",
            "rwanda franc",
            "rwanda francs",
        ],
        "AED": [
            "aed",
            "dirham",
            "dirhams",
        ],
        "ZAR": [
            "zar",
            "rand",
            "rands",
        ],
        "NGN": [
            "ngn",
            "naira",
        ],
    }

    currency = None

    for code in currency_aliases:
        if re.search(rf"\b{re.escape(code.lower())}\b", lowered):
            currency = code
            break

    if currency is None:
        for code, aliases in currency_aliases.items():
            if any(alias in lowered for alias in aliases):
                currency = code
                break

    amount = parse_amount(text)

    sell_to_bureau_phrases = [
        "i want to sell",
        "want to sell",
        "selling",
        "sell dollars",
        "sell usd",
        "i have",
        "i've got",
        "i got",
        "foreign currency to kes",
        "convert usd to kes",
        "convert dollars to kes",
    ]

    buy_from_bureau_phrases = [
        "i want to buy",
        "want to buy",
        "buying",
        "buy dollars",
        "buy usd",
        "purchase",
        "kes to usd",
        "kes to dollars",
        "kes to euro",
        "kes to eur",
    ]

    if any(phrase in lowered for phrase in sell_to_bureau_phrases):
        direction = "sell_to_bureau"
    elif any(phrase in lowered for phrase in buy_from_bureau_phrases):
        direction = "buy_from_bureau"
    else:
        direction = "unknown"

    if "buying rate" in lowered or "bureau buys" in lowered:
        direction = "sell_to_bureau"

    if "selling rate" in lowered or "bureau sells" in lowered:
        direction = "buy_from_bureau"

    return {
        "currency": currency,
        "amount": amount,
        "direction": direction,
    }


def get_rate_row(
    rows: List[Dict[str, str]],
    currency: str,
) -> Optional[Dict[str, str]]:
    matching_rows = []

    for row in rows:
        row_currency = row.get("currency", "").upper()
        row_status = row.get("status", "active").lower()

        if (
            row_currency == currency.upper()
            and row_status in ("active", "published", "live", "")
        ):
            matching_rows.append(row)

    if not matching_rows:
        return None

    return matching_rows[-1]


def calculate_kes_amount(
    amount: float,
    rate: float,
) -> float:
    return amount * rate


def format_number(value: float) -> str:
    if value.is_integer():
        return f"{int(value):,}"

    return f"{value:,.2f}".rstrip("0").rstrip(".")


def build_reply(
    parsed: Dict[str, Any],
    rate_row: Dict[str, str],
) -> str:
    currency = parsed["currency"]
    amount = parsed["amount"]
    direction = parsed["direction"]

    buy_rate = float(rate_row["buy_rate"])
    sell_rate = float(rate_row["sell_rate"])

    availability = rate_row.get("availability", "")
    updated_at = rate_row.get("updated_at", "")

    availability_text = ""

    if availability:
        availability_text = f"\nAvailability: {availability}."

    updated_text = ""

    if updated_at:
        updated_text = f"\nUpdated: {updated_at}."

    if direction == "sell_to_bureau":
        rate = buy_rate
        response = (
            f"Our current indicative {currency} buying rate is "
            f"KSh {format_number(rate)} per {currency}."
        )

        if amount is not None:
            kes_amount = calculate_kes_amount(amount, rate)
            response += (
                f"\nFor {format_number(amount)} {currency}, "
                f"the estimated amount is KSh {format_number(kes_amount)}."
            )

        return (
            response
            + updated_text
            + availability_text
            + "\nThe final rate is subject to bureau confirmation."
        )

    if direction == "buy_from_bureau":
        rate = sell_rate
        response = (
            f"Our current indicative {currency} selling rate is "
            f"KSh {format_number(rate)} per {currency}."
        )

        if amount is not None:
            kes_amount = calculate_kes_amount(amount, rate)
            response += (
                f"\nBuying {format_number(amount)} {currency} would cost "
                f"approximately KSh {format_number(kes_amount)}."
            )

        return (
            response
            + updated_text
            + availability_text
            + "\nThe final rate is subject to bureau confirmation."
        )

    return (
        f"Our current indicative {currency} rates are:"
        f"\n- We buy {currency} at KSh {format_number(buy_rate)}."
        f"\n- We sell {currency} at KSh {format_number(sell_rate)}."
        f"{updated_text}"
        f"{availability_text}"
        "\nAre you selling or buying the currency?"
    )


def send_whatsapp_reply(
    recipient_phone: str,
    message: str,
) -> Dict[str, Any]:
    if not WHATSAPP_TOKEN:
        raise RuntimeError("WHATSAPP_TOKEN is not configured.")

    if not PHONE_NUMBER_ID:
        raise RuntimeError("PHONE_NUMBER_ID is not configured.")

    url = (
        f"https://graph.facebook.com/"
        f"{GRAPH_API_VERSION}/"
        f"{PHONE_NUMBER_ID}/messages"
    )

    headers = {
        "Authorization": f"Bearer {WHATSAPP_TOKEN}",
        "Content-Type": "application/json",
    }

    payload = {
        "messaging_product": "whatsapp",
        "recipient_type": "individual",
        "to": recipient_phone,
        "type": "text",
        "text": {
            "preview_url": False,
            "body": message[:4096],
        },
    }

    response = requests.post(
        url,
        headers=headers,
        json=payload,
        timeout=20,
    )

    if not response.ok:
        raise RuntimeError(
            f"WhatsApp API error {response.status_code}: {response.text}"
        )

    return response.json()


def extract_messages(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    messages = []

    for entry in payload.get("entry", []):
        for change in entry.get("changes", []):
            value = change.get("value", {})
            metadata = value.get("metadata", {})

            recipient_phone_number = metadata.get("display_phone_number")

            for message in value.get("messages", []):
                if message.get("type") != "text":
                    continue

                message_text = (
                    message.get("text", {})
                    .get("body", "")
                )

                messages.append(
                    {
                        "message_id": message.get("id"),
                        "sender_phone": message.get("from"),
                        "message_text": message_text,
                        "recipient_phone_number": recipient_phone_number,
                    }
                )

    return messages


def process_message(message: Dict[str, Any]) -> None:
    message_id = message.get("message_id")

    if message_id and message_id in PROCESSED_MESSAGE_IDS:
        return

    if message_id:
        PROCESSED_MESSAGE_IDS.add(message_id)

    sender_phone = message.get("sender_phone")
    message_text = message.get("message_text", "").strip()

    if not sender_phone or not message_text:
        return

    parsed = parse_message(message_text)

    if parsed["currency"] is None:
        reply = (
            "Please specify a currency, such as USD, EUR, or GBP. "
            'Example: "I want to sell USD 500."'
        )
        send_whatsapp_reply(sender_phone, reply)
        return

    try:
        rows = read_rates_from_csv()
    except Exception:
        send_whatsapp_reply(
            sender_phone,
            "I could not retrieve the latest rates right now. "
            "Please contact the bureau directly.",
        )
        return

    rate_row = get_rate_row(rows, parsed["currency"])

    if rate_row is None:
        send_whatsapp_reply(
            sender_phone,
            f"We do not currently have an active rate for "
            f"{parsed['currency']}. Please contact the bureau.",
        )
        return

    reply = build_reply(parsed, rate_row)
    send_whatsapp_reply(sender_phone, reply)


@app.get("/")
def root() -> Dict[str, str]:
    return {
        "status": "ok",
        "service": "XchangeIQ WhatsApp Webhook",
    }


@app.get("/health")
def health() -> Dict[str, str]:
    return {
        "status": "ok",
    }


@app.get("/webhook", response_class=PlainTextResponse)
def verify_webhook(
    hub_mode: Optional[str] = Query(default=None, alias="hub.mode"),
    hub_challenge: Optional[str] = Query(
        default=None,
        alias="hub.challenge",
    ),
    hub_verify_token: Optional[str] = Query(
        default=None,
        alias="hub.verify_token",
    ),
) -> PlainTextResponse:
    if not VERIFY_TOKEN:
        raise HTTPException(
            status_code=500,
            detail="VERIFY_TOKEN is not configured.",
        )

    if (
        hub_mode == "subscribe"
        and hub_verify_token == VERIFY_TOKEN
        and hub_challenge is not None
    ):
        return PlainTextResponse(
            content=hub_challenge,
            status_code=200,
        )

    raise HTTPException(
        status_code=403,
        detail="Webhook verification failed.",
    )


@app.post("/webhook")
def receive_webhook(payload: Dict[str, Any]) -> Dict[str, str]:
    if payload.get("object") != "whatsapp_business_account":
        return {
            "status": "ignored",
        }

    messages = extract_messages(payload)

    for message in messages:
        try:
            process_message(message)
        except Exception:
            continue

    return {
        "status": "received",
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "8000")),
    )