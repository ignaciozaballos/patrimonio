#!/usr/bin/env python3
"""
Actualiza los precios (valores liquidativos) de fondos, acciones y planes de
pensiones y los guarda en Supabase. Solo usa la librería estándar de Python.

Uso:
  python scripts/update_prices.py                  # actualiza y guarda en Supabase
  python scripts/update_prices.py --dry-run        # lo mismo pero sin guardar nada
  python scripts/update_prices.py probe ISIN ...   # prueba fuentes para ISIN, código DGS o ticker

Variables de entorno (solo para actualizar):
  SUPABASE_URL          https://xxxx.supabase.co
  SUPABASE_SECRET_KEY   clave secreta (sb_secret_...) o la antigua service_role
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/124.0 Safari/537.36")
MADRID = ZoneInfo("Europe/Madrid")

# Antigüedad máxima (días) del valor liquidativo para darlo por bueno.
MAX_AGE_DAYS = {"fondo": 10, "plan_pensiones": 21, "accion": 7}
# Variación máxima respecto al último precio guardado; más allá se considera sospechoso
# (típico error de decimales o de fuente) y NO se guarda.
MAX_JUMP = {"fondo": 0.20, "plan_pensiones": 0.20, "accion": 0.60}
# Si no se consigue precio y el último guardado tiene más de estos días, el flujo falla (te avisa GitHub).
FAIL_IF_LAST_OLDER_THAN = 7
JUMP_CHECK_WINDOW_DAYS = 45


class SourceError(Exception):
    """Una fuente no ha dado un precio utilizable."""


class FetchError(SourceError):
    pass


@dataclass
class Quote:
    price: float
    nav_date: date | None
    source: str
    detail: str = ""


# ----------------------------------------------------------------------------
#  Utilidades: red, texto, números y fechas
# ----------------------------------------------------------------------------
def http_get(url: str, headers: dict | None = None, timeout: int = 30, retries: int = 3) -> str:
    h = {
        "User-Agent": UA,
        "Accept": "text/html,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
    }
    h.update(headers or {})
    last: Exception | None = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=h)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                charset = r.headers.get_content_charset() or "utf-8"
                return raw.decode(charset, errors="replace")
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (400, 401, 403, 404):
                break  # reintentar no ayuda
        except Exception as e:  # red, timeout, DNS...
            last = e
        time.sleep(2 * (i + 1))
    raise FetchError(f"{type(last).__name__}: {last}")


def html_to_text(raw: str) -> str:
    raw = re.sub(r"(?is)<(script|style|noscript|svg)\b.*?</\1>", " ", raw)
    raw = re.sub(r"(?i)<br\s*/?>|</(p|div|li|tr|h\d|section|td|th)>", "\n", raw)
    raw = re.sub(r"(?s)<[^>]+>", " ", raw)
    raw = html.unescape(raw)
    raw = re.sub(r"[ \t\r\f\v ]+", " ", raw)
    raw = re.sub(r"\s*\n\s*", "\n", raw)
    return raw.strip()


def parse_number(s: str, decimal: str | None = None) -> float:
    """Convierte '13,066492', '1.234,56', '446.9632' o '1,234.56' en float.
    'decimal' es una pista (',' o '.') para los casos ambiguos como '1.234'."""
    s = re.sub(r"[\s ]", "", s)
    has_c, has_d = "," in s, "." in s
    if has_c and has_d:
        dec = "," if s.rfind(",") > s.rfind(".") else "."
    elif has_c:
        dec = ","
        if decimal == "." and re.fullmatch(r"\d{1,3}(,\d{3})+", s):
            dec = "."
    elif has_d:
        dec = "."
        if decimal == "," and re.fullmatch(r"\d{1,3}(\.\d{3})+", s):
            dec = ","
    else:
        dec = "."
    s = s.replace(".", "").replace(",", ".") if dec == "," else s.replace(",", "")
    return float(s)


_MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}
DATE_PATTERN = (r"(\d{1,2}[./]\d{1,2}[./]\d{2,4}|\d{4}-\d{2}-\d{2}"
                r"|[A-Z][a-z]{2}[a-z]*\.? \d{1,2},? \d{4})")


def parse_date(s: str) -> date | None:
    s = s.strip()
    for fmt in ("%d/%m/%Y", "%d.%m.%Y", "%d/%m/%y", "%d.%m.%y", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    m = re.fullmatch(r"([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})", s)
    if m and m.group(1).lower() in _MONTHS:
        try:
            return date(int(m.group(3)), _MONTHS[m.group(1).lower()], int(m.group(2)))
        except ValueError:
            return None
    return None


def find_date(text: str) -> date | None:
    m = re.search(DATE_PATTERN, text)
    return parse_date(m.group(1)) if m else None


def _check_price(price: float, what: str) -> float:
    if not (price > 0) or price != price or price in (float("inf"),):
        raise SourceError(f"{what}: precio no válido ({price})")
    return price


# ----------------------------------------------------------------------------
#  Fuentes de precio
# ----------------------------------------------------------------------------
def yahoo_search(isin: str) -> list[str]:
    # Yahoo limita (429) según el servidor: si uno rechaza, se prueba el otro
    err: Exception | None = None
    data = None
    for host in ("query2", "query1"):
        url = (f"https://{host}.finance.yahoo.com/v1/finance/search?q="
               f"{urllib.parse.quote(isin)}&quotesCount=6&newsCount=0&listsCount=0")
        try:
            data = json.loads(http_get(url, retries=2))
            break
        except (FetchError, ValueError) as e:
            err = e
    if data is None:
        raise err  # type: ignore[misc]
    out = []
    for q in data.get("quotes", []):
        if q.get("quoteType") in ("MUTUALFUND", "ETF", "EQUITY") and q.get("symbol"):
            out.append(q["symbol"])
    return out


def yahoo_chart(symbol: str, currency: str = "EUR") -> Quote:
    url = ("https://query1.finance.yahoo.com/v8/finance/chart/"
           f"{urllib.parse.quote(symbol)}?range=10d&interval=1d")
    data = json.loads(http_get(url))
    chart = data.get("chart", {})
    res = chart.get("result")
    if not res:
        err = (chart.get("error") or {}).get("description", "sin resultados")
        raise SourceError(f"yahoo {symbol}: {err}")
    meta = res[0].get("meta", {})
    cur = str(meta.get("currency", "")).upper()
    if cur != currency.upper():
        raise SourceError(f"yahoo {symbol}: divisa {cur or '?'} (se esperaba {currency})")
    ts_list = res[0].get("timestamp") or []
    closes = ((res[0].get("indicators") or {}).get("quote") or [{}])[0].get("close") or []
    price = meta.get("regularMarketPrice")
    ts = meta.get("regularMarketTime")
    if price is None:
        for t, c in zip(reversed(ts_list), reversed(closes)):
            if c is not None:
                price, ts = c, t
                break
    if price is None:
        raise SourceError(f"yahoo {symbol}: sin precio")
    tz = ZoneInfo(meta["exchangeTimezoneName"]) if meta.get("exchangeTimezoneName") else timezone.utc
    nav = datetime.fromtimestamp(ts, tz).date() if ts else None
    return Quote(_check_price(float(price), f"yahoo {symbol}"), nav, "yahoo", symbol)


def src_yahoo(cfg: dict) -> Quote:
    if cfg.get("symbol"):
        symbols = [cfg["symbol"]]
    elif cfg.get("isin"):
        symbols = yahoo_search(cfg["isin"])
        if not symbols:
            raise SourceError(f"yahoo: no conoce el ISIN {cfg['isin']}")
    else:
        raise SourceError("yahoo: falta 'symbol' o 'isin'")
    errors = []
    for sym in symbols[:4]:
        try:
            return yahoo_chart(sym, cfg.get("currency", "EUR"))
        except SourceError as e:
            errors.append(str(e))
    raise SourceError("; ".join(errors))


def parse_ft(text: str) -> Quote:
    m = re.search(r"Price \(([A-Z]{3})\)\s*([\d,]*\.?\d+)", text)
    if not m:
        raise SourceError("ft: no encuentro 'Price (EUR)' en la página")
    if m.group(1) != "EUR":
        raise SourceError(f"ft: divisa {m.group(1)} (se esperaba EUR)")
    price = _check_price(parse_number(m.group(2), "."), "ft")
    return Quote(price, find_date(text[m.end(): m.end() + 600]), "ft")


def src_ft(cfg: dict) -> Quote:
    ident = cfg.get("id") or (cfg.get("isin", "") + ":EUR")
    url = "https://markets.ft.com/data/funds/tearsheet/summary?s=" + urllib.parse.quote(ident)
    return parse_ft(html_to_text(http_get(url)))


def parse_ft_equity(text: str) -> Quote:
    q = parse_ft(text)
    q.source = "ft_equity"
    return q


def src_ft_equity(cfg: dict) -> Quote:
    url = "https://markets.ft.com/data/equities/tearsheet/summary?s=" + urllib.parse.quote(cfg["id"])
    return parse_ft_equity(html_to_text(http_get(url)))


def src_ft_etf(cfg: dict) -> Quote:
    """ETF en FT: `id` es ISIN:EUR o el símbolo de su bolsa, p. ej. XAIX:GER."""
    ident = cfg.get("id") or (cfg.get("isin", "") + ":EUR")
    url = "https://markets.ft.com/data/etfs/tearsheet/summary?s=" + urllib.parse.quote(ident)
    q = parse_ft(html_to_text(http_get(url)))
    q.source = "ft_etf"
    return q


def parse_stooq(text: str) -> Quote:
    """CSV de https://stooq.com/q/l/?s=abvx.fr&f=sd2t2c&h&e=csv  ->  Symbol,Date,Time,Close"""
    rows = [r.strip() for r in text.strip().splitlines() if r.strip()]
    if len(rows) < 2:
        raise SourceError("stooq: respuesta vacía")
    cols = [c.strip() for c in rows[1].split(",")]
    if len(cols) < 4 or "N/D" in cols[1:4]:
        raise SourceError("stooq: sin datos para ese símbolo")
    price = _check_price(parse_number(cols[3], "."), "stooq")
    return Quote(price, parse_date(cols[1]), "stooq")


def src_stooq(cfg: dict) -> Quote:
    url = "https://stooq.com/q/l/?s=" + urllib.parse.quote(cfg["symbol"].lower()) + "&f=sd2t2c&h&e=csv"
    return parse_stooq(http_get(url))


def parse_quefondos(text: str) -> Quote:
    m = re.search(r"Valor liquidativo:\s*([\d.]+,\d+|\d+\.\d+|\d+)\s*EUR", text, re.I)
    if not m:
        raise SourceError("quefondos: no encuentro 'Valor liquidativo'")
    price = _check_price(parse_number(m.group(1), ","), "quefondos")
    dm = re.search(r"Fecha:?\s*" + DATE_PATTERN, text[m.end(): m.end() + 400])
    return Quote(price, parse_date(dm.group(1)) if dm else None, "quefondos")


def src_quefondos(cfg: dict) -> Quote:
    kind = cfg.get("kind", "fondos")
    url = (f"https://www.quefondos.com/es/{kind}/ficha/index.html?isin="
           f"{urllib.parse.quote(cfg['id'])}")
    return parse_quefondos(html_to_text(http_get(url)))


def parse_finect(text: str) -> Quote:
    m = (re.search(r"(\d[\d.]*,\d+)\s*Fecha de valor liquidativo:?\s*", text)
         or re.search(r"(\d[\d.]*,\d+)\s*€[^\d]{0,120}?Fecha de valor liquidativo:?\s*", text))
    if m:
        price = _check_price(parse_number(m.group(1), ","), "finect")
        dm = re.match(DATE_PATTERN, text[m.end(): m.end() + 40])
        return Quote(price, parse_date(dm.group(1)) if dm else None, "finect")
    # Planes de pensiones: "13,25€ Datos a 20/09/2026" (cabecera de la ficha, sin la etiqueta de VL)
    m = re.search(r"(\d[\d.]*,\d+)\s*€\s*Datos a\s*" + DATE_PATTERN, text)
    if m:
        return Quote(_check_price(parse_number(m.group(1), ","), "finect"), parse_date(m.group(2)), "finect")
    # Planes de pensiones: "Valor liquidativo 12,3456 € ... 10/10/2026" (el número va después de la etiqueta)
    m = re.search(r"[Vv]alor liquidativo:?\s*(?:\(?[^\d\n]{0,40}\)?\s*)?(\d[\d.]*,\d+)\s*€?"
                  r"(?:[^\d]{0,60}?" + DATE_PATTERN + ")?", text)
    if m:
        price = _check_price(parse_number(m.group(1), ","), "finect")
        dm = re.search(DATE_PATTERN, text[m.end(1): m.end(1) + 120])
        return Quote(price, parse_date(dm.group(1)) if dm else None, "finect")
    i = text.lower().find("liquidativo")
    snippet = re.sub(r"\s+", " ", text[max(0, i - 60): i + 200]) if i >= 0 else "(la página no menciona 'liquidativo')"
    raise SourceError(f"finect: no encuentro el valor liquidativo. Texto cercano: {snippet}")


def src_finect(cfg: dict) -> Quote:
    kind = cfg.get("kind", "fondos-inversion")
    ident = cfg.get("id") or cfg.get("isin")
    if not ident:
        raise SourceError("finect: falta 'isin' o 'id'")
    url = f"https://www.finect.com/{kind}/{urllib.parse.quote(ident)}"
    return parse_finect(html_to_text(http_get(url)))


def src_url_regex(cfg: dict) -> Quote:
    """Escape para cualquier web: {"type":"url_regex","url":"...","price_regex":"VL\\s*([\\d.,]+)",
    "date_regex":"(\\d{2}/\\d{2}/\\d{4})","decimal":","}"""
    raw = http_get(cfg["url"])
    text = html_to_text(raw) if cfg.get("as_text", True) else raw
    m = re.search(cfg["price_regex"], text, re.S)
    if not m:
        raise SourceError("url_regex: el patrón de precio no encuentra nada")
    price = _check_price(parse_number(m.group(1), cfg.get("decimal")), "url_regex")
    nav = None
    if cfg.get("date_regex"):
        dm = re.search(cfg["date_regex"], text, re.S)
        nav = parse_date(dm.group(1)) if dm else None
    return Quote(price, nav, "url_regex", cfg["url"])


SOURCES = {
    "yahoo": src_yahoo,
    "ft": src_ft,
    "quefondos": src_quefondos,
    "finect": src_finect,
    "ft_equity": src_ft_equity,
    "ft_etf": src_ft_etf,
    "stooq": src_stooq,
    "url_regex": src_url_regex,
}


def fetch_quote(cfg: dict) -> Quote:
    fn = SOURCES.get(cfg.get("type"))
    if not fn:
        raise SourceError(f"tipo de fuente desconocido: {cfg.get('type')}")
    return fn(cfg)


def label(cfg: dict) -> str:
    keys = [str(cfg[k]) for k in ("symbol", "isin", "id", "url") if cfg.get(k)]
    return f"{cfg.get('type')}({', '.join(keys)})"


# ----------------------------------------------------------------------------
#  Elegir el mejor precio entre las fuentes de un producto
# ----------------------------------------------------------------------------
def choose_quote(sources: list[dict], today: date, max_age: int, fetch=fetch_quote):
    """Devuelve (Quote|None, [errores]). Recorre las fuentes en orden y se queda con la
    primera que da un precio reciente; si ninguna es reciente, con el más reciente de todos."""
    errors: list[str] = []
    stale: Quote | None = None
    for cfg in sources:
        try:
            q = fetch(cfg)
        except Exception as e:  # una fuente rota no debe parar a las demás
            errors.append(f"{label(cfg)}: {e}")
            continue
        if q.nav_date and q.nav_date > today + timedelta(days=1):
            q.nav_date = None  # fecha en el futuro = mal leída; la ignoramos
        limit = cfg.get("max_age_days", max_age)
        if q.nav_date is None or (today - q.nav_date).days <= limit:
            return q, errors
        errors.append(f"{label(cfg)}: dato antiguo ({q.nav_date.isoformat()})")
        if stale is None or q.nav_date > stale.nav_date:
            stale = q
    return stale, errors


# ----------------------------------------------------------------------------
#  Base de datos (Supabase REST)
# ----------------------------------------------------------------------------
class SupabaseDb:
    def __init__(self, url: str, key: str):
        self.base = url.rstrip("/") + "/rest/v1"
        self.headers = {"apikey": key, "Content-Type": "application/json"}
        if not key.startswith("sb_secret_"):  # las claves sb_secret_ NO van en Authorization
            self.headers["Authorization"] = f"Bearer {key}"

    def _request(self, method: str, path: str, body=None, extra: dict | None = None):
        h = dict(self.headers)
        h.update(extra or {})
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, headers=h, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read().decode()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:300]
            raise RuntimeError(f"Supabase {method} {path.split('?')[0]} -> HTTP {e.code}: {detail}")

    def get_assets(self) -> list[dict]:
        return self._request(
            "GET",
            "/assets?select=id,user_id,name,category,valuation,sources&active=eq.true&order=sort,name")

    def get_loans(self) -> list[dict]:
        return self._request("GET", "/assets?select=id,user_id,name,loan&active=eq.true&loan=not.is.null&order=sort,name")

    def get_plans(self) -> list[dict]:
        return self._request("GET", "/assets?select=id,user_id,name,plan&active=eq.true&plan=not.is.null&order=sort,name")

    def last_holding(self, asset_id: str) -> dict | None:
        rows = self._request("GET", f"/holdings?select=date,units&asset_id=eq.{asset_id}&order=date.desc&limit=1")
        return rows[0] if rows else None

    def price_on_or_after(self, asset_id: str, d: str) -> dict | None:
        rows = self._request(
            "GET", f"/prices?select=date,price&asset_id=eq.{asset_id}&date=gte.{d}&order=date.asc&limit=1")
        return rows[0] if rows else None

    def upsert_holding(self, row: dict) -> None:
        self._request("POST", "/holdings?on_conflict=asset_id,date", [row],
                      {"Prefer": "resolution=merge-duplicates,return=minimal"})

    def loan_anchor(self, asset_id: str) -> dict | None:
        """Último valor anotado a mano (no calculado): el punto de partida de la amortización."""
        rows = self._request(
            "GET", f"/manual_values?select=date,value&asset_id=eq.{asset_id}&auto=eq.false&order=date.desc&limit=1")
        return rows[0] if rows else None

    def delete_auto_after(self, asset_id: str, d: str) -> None:
        self._request("DELETE", f"/manual_values?asset_id=eq.{asset_id}&auto=eq.true&date=gt.{d}",
                      None, {"Prefer": "return=minimal"})

    def upsert_manual(self, rows: list[dict]) -> None:
        if rows:
            self._request("POST", "/manual_values?on_conflict=asset_id,date", rows,
                          {"Prefer": "resolution=merge-duplicates,return=minimal"})

    def last_price(self, asset_id: str) -> dict | None:
        rows = self._request(
            "GET",
            f"/prices?select=date,nav_date,price,source&asset_id=eq.{asset_id}&order=date.desc&limit=1")
        return rows[0] if rows else None

    def upsert_price(self, row: dict) -> None:
        self._request("POST", "/prices?on_conflict=asset_id,date", [row],
                      {"Prefer": "resolution=merge-duplicates,return=minimal"})


# ----------------------------------------------------------------------------
#  Flujo de actualización
# ----------------------------------------------------------------------------
@dataclass
class Result:
    name: str
    status: str  # OK | SIN CAMBIOS | MANUAL | SIN FUENTES | AVISO | SOSPECHOSO | ERROR
    price: float | None = None
    nav_date: date | None = None
    source: str = ""
    note: str = ""
    failure: bool = False


def _days_since(d: str | None, today: date) -> int | None:
    if not d:
        return None
    return (today - date.fromisoformat(d)).days


def run_update(db, today: date, dry_run: bool = False, fetch=fetch_quote) -> list[Result]:
    results: list[Result] = []
    for a in db.get_assets():
        if a.get("valuation") != "units":
            continue
        name, cat = a["name"], a["category"]
        sources = a.get("sources") or []
        if not sources:
            results.append(Result(name, "SIN FUENTES", note="precio manual (sin fuentes configuradas)"))
            continue
        last = db.last_price(a["id"])
        if last and last.get("source") == "manual" and last.get("date") == today.isoformat():
            results.append(Result(name, "MANUAL", float(last["price"]), note="hoy hay un precio manual; no se toca"))
            continue

        q, errors = choose_quote(sources, today, MAX_AGE_DAYS.get(cat, 10), fetch)
        last_age = _days_since(last["date"], today) if last else None

        if q is None:
            fail = last is None or last_age > FAIL_IF_LAST_OLDER_THAN
            note = " | ".join(errors) or "sin respuesta"
            if not fail:
                note += f" | se mantiene el último precio ({last['date']})"
            results.append(Result(name, "ERROR", note=note, failure=fail))
            continue

        note = " | ".join(errors)
        if q.nav_date and (today - q.nav_date).days > MAX_AGE_DAYS.get(cat, 10):
            note = (note + " | " if note else "") + f"el valor liquidativo es del {q.nav_date.isoformat()}"
        if last and last_age is not None and last_age <= JUMP_CHECK_WINDOW_DAYS and float(last["price"]) > 0:
            jump = abs(q.price / float(last["price"]) - 1)
            if jump > MAX_JUMP.get(cat, 0.25):
                results.append(Result(
                    name, "SOSPECHOSO", q.price, q.nav_date, q.source,
                    f"varía {jump:.0%} frente al último ({float(last['price'])}); no se guarda. "
                    "Si es correcto, introdúcelo a mano en la web.", failure=True))
                continue
        if (last and float(last["price"]) == q.price and (last.get("nav_date") or None) ==
                (q.nav_date.isoformat() if q.nav_date else None)):
            results.append(Result(name, "SIN CAMBIOS", q.price, q.nav_date, q.source, note))
            continue

        if not dry_run:
            db.upsert_price({
                "user_id": a["user_id"], "asset_id": a["id"], "date": today.isoformat(),
                "nav_date": q.nav_date.isoformat() if q.nav_date else None,
                "price": q.price, "source": q.source,
            })
        results.append(Result(name, "OK" if not note else "AVISO", q.price, q.nav_date, q.source, note))
    return results


def _payment_date(year: int, month: int, day: int) -> date:
    """Día de cobro de ese mes; si el mes no tiene ese día (30 de febrero) se usa el último."""
    nxt = date(year + (month == 12), month % 12 + 1, 1)
    return date(year, month, min(day, (nxt - timedelta(days=1)).day))


def loan_schedule(balance: float, annual_rate_pct: float, payment: float, day: int,
                  anchor: date, today: date) -> list[tuple[date, float]]:
    """Capital pendiente tras cada cuota cobrada después de `anchor` y hasta `today` (amortización
    francesa: intereses del mes = pendiente × tipo / 12; el resto de la cuota amortiza capital)."""
    if not (1 <= day <= 31):
        raise ValueError("el día de cobro debe estar entre 1 y 31")
    if payment <= 0 or annual_rate_pct < 0:
        raise ValueError("cuota o tipo no válidos")
    out: list[tuple[date, float]] = []
    y, m = anchor.year, anchor.month
    d = _payment_date(y, m, day)
    if d <= anchor:
        y, m = y + (m == 12), m % 12 + 1
        d = _payment_date(y, m, day)
    bal = round(balance, 2)
    while d <= today and bal > 0:
        interest = bal * annual_rate_pct / 100 / 12
        if payment <= interest:
            raise ValueError(f"la cuota ({payment:g}) no cubre los intereses del mes ({interest:.2f})")
        bal = max(0.0, round(bal - (payment - interest), 2))
        out.append((d, bal))
        y, m = y + (m == 12), m % 12 + 1
        d = _payment_date(y, m, day)
    return out


def run_loans(db, today: date, dry_run: bool = False) -> list[Result]:
    """Genera los valores mensuales de los préstamos con cuota fija a partir del último valor anotado a mano."""
    results: list[Result] = []
    for a in db.get_loans():
        name, cfg = a["name"], a.get("loan") or {}
        try:
            payment, rate, day = float(cfg["payment"]), float(cfg.get("rate", 0)), int(cfg["day"])
        except (KeyError, TypeError, ValueError):
            results.append(Result(name, "HIPOTECA", note="faltan cuota o día de cobro en los datos del préstamo",
                                  failure=True))
            continue
        anchor = db.loan_anchor(a["id"])
        if not anchor:
            results.append(Result(name, "HIPOTECA", note="anota primero en la web el capital pendiente de hoy"))
            continue
        a0 = date.fromisoformat(anchor["date"])
        try:
            steps = loan_schedule(float(anchor["value"]), rate, payment, day, a0, today)
        except ValueError as e:
            results.append(Result(name, "HIPOTECA", note=str(e), failure=True))
            continue
        if not dry_run:
            db.delete_auto_after(a["id"], a0.isoformat())
            db.upsert_manual([{"user_id": a["user_id"], "asset_id": a["id"], "date": d.isoformat(),
                               "value": v, "auto": True} for d, v in steps])
        last = steps[-1][1] if steps else float(anchor["value"])
        results.append(Result(name, "HIPOTECA", last, steps[-1][0] if steps else a0, "amortización",
                              f"{len(steps)} cuota(s) calculadas desde el valor del {a0.isoformat()}"))
    return results


def plan_dates(day: int, anchor: date, today: date) -> list[date]:
    """Fechas de aportación (día fijo de cada mes) posteriores a `anchor` y hasta `today`."""
    if not (1 <= day <= 31):
        raise ValueError("el día de aportación debe estar entre 1 y 31")
    out: list[date] = []
    y, m = anchor.year, anchor.month
    while True:
        d = _payment_date(y, m, day)
        if d > today:
            return out
        if d > anchor:
            out.append(d)
        y, m = y + (m == 12), m % 12 + 1


def run_plans(db, today: date, dry_run: bool = False, max_wait_days: int = 10) -> list[Result]:
    """Aportaciones periódicas: cada mes suma importe / precio de ese día a las participaciones.
    Parte de la última fecha de participaciones registrada; si cambias las participaciones a mano, continúa desde ahí."""
    results: list[Result] = []
    for a in db.get_plans():
        name, cfg = a["name"], a.get("plan") or {}
        try:
            amount, day = float(cfg["amount"]), int(cfg["day"])
            if amount <= 0:
                raise ValueError
        except (KeyError, TypeError, ValueError):
            results.append(Result(name, "APORTACIÓN", note="faltan importe o día de la aportación", failure=True))
            continue
        last = db.last_holding(a["id"])
        if not last:
            results.append(Result(name, "APORTACIÓN", note="indica primero las participaciones actuales"))
            continue
        anchor, units, done = date.fromisoformat(last["date"]), float(last["units"]), 0
        try:
            dates = plan_dates(day, anchor, today)
        except ValueError as e:
            results.append(Result(name, "APORTACIÓN", note=str(e), failure=True))
            continue
        note = ""
        for d in dates:
            px = db.price_on_or_after(a["id"], d.isoformat())
            if not px or (date.fromisoformat(px["date"]) - d).days > max_wait_days:
                note = f"aportación del {d.isoformat()} pendiente: aún no hay precio de ese día"
                break
            units = round(units + amount / float(px["price"]), 6)
            if not dry_run:
                db.upsert_holding({"user_id": a["user_id"], "asset_id": a["id"], "date": d.isoformat(),
                                   "units": units})
            done += 1
        results.append(Result(name, "APORTACIÓN", units, date.fromisoformat(last["date"]) if not done else d,
                              "aportación periódica", note or f"{done} aportación(es) de {amount:g} € añadidas"))
    return results


def render(results: list[Result], today: date, dry_run: bool) -> tuple[str, str]:
    """Devuelve (texto para consola, markdown para el resumen de GitHub)."""
    lines = [f"Actualización de precios · {today.isoformat()}" + (" (simulación)" if dry_run else "")]
    md = [f"### Precios · {today.isoformat()}" + (" (simulación)" if dry_run else ""), "",
          "| Producto | Estado | Precio | Fecha VL | Fuente | Nota |", "|---|---|---|---|---|---|"]
    for r in results:
        price = f"{r.price:g}" if r.price is not None else "—"
        nav = r.nav_date.isoformat() if r.nav_date else "—"
        lines.append(f"  [{r.status:<11}] {r.name} · {price} · VL {nav} · {r.source or '—'}"
                     + (f"\n      {r.note}" if r.note else ""))
        md.append(f"| {r.name} | {r.status} | {price} | {nav} | {r.source or '—'} | {r.note.replace('|', '/')} |")
    return "\n".join(lines), "\n".join(md)


def classify(ident: str) -> str:
    if re.fullmatch(r"[A-Z]{2}[A-Z0-9]{9}\d", ident):
        return "isin"
    if re.fullmatch(r"[NFPJ]\d{4}", ident):
        return "dgs"
    if re.fullmatch(r"[NFPJ]\d{4}-[\w.-]+", ident):
        return "finect_slug"
    return "ticker"


def candidate_sources(ident: str) -> list[dict]:
    kind = classify(ident)
    if kind == "isin":
        return [{"type": "yahoo", "isin": ident}, {"type": "ft", "id": f"{ident}:EUR"},
                {"type": "ft_etf", "id": f"{ident}:EUR"},
                {"type": "finect", "isin": ident}, {"type": "quefondos", "kind": "fondos", "id": ident}]
    if ":" in ident:  # símbolo de FT, p. ej. XAIX:GER (ETF o acción)
        return [{"type": "ft_etf", "id": ident}, {"type": "ft_equity", "id": ident}]
    if kind == "finect_slug":  # p. ej. N5568-Indexa_empleo_autonomos_100_accs_ppes (final de la URL de Finect)
        return [{"type": "finect", "kind": "planes-pensiones", "id": ident}]
    if kind == "dgs":
        return [{"type": "quefondos", "kind": "planes", "id": ident},
                {"type": "finect", "kind": "planes-pensiones", "id": ident}]
    out = [{"type": "yahoo", "symbol": ident}]
    base, _, suffix = ident.partition(".")
    stooq = {"PA": "fr", "MC": "es", "DE": "de", "L": "uk", "MI": "it", "AS": "nl"}
    ft = {"PA": "PAR", "MC": "MCE", "DE": "GER", "L": "LSE", "MI": "MIL", "AS": "AEX"}
    if suffix in stooq:
        out.append({"type": "stooq", "symbol": f"{base}.{stooq[suffix]}"})
        out.append({"type": "ft_equity", "id": f"{base}:{ft[suffix]}"})
    return out


def probe(idents: list[str], fetch=fetch_quote) -> tuple[str, str]:
    lines, md = [], ["### Prueba de fuentes", "", "| Identificador | Fuente | Resultado |", "|---|---|---|"]
    for ident in idents:
        lines.append(f"\n{ident} ({classify(ident)})")
        for cfg in candidate_sources(ident):
            try:
                q = fetch(cfg)
                res = f"OK  {q.price:g}  VL {q.nav_date.isoformat() if q.nav_date else 'sin fecha'}" + \
                      (f"  [{q.detail}]" if q.detail else "")
            except Exception as e:
                res = f"FALLA  {e}"
            lines.append(f"  {label(cfg):<55} {res}")
            md.append(f"| {ident} | {label(cfg)} | {res.replace('|', '/')} |")
    return "\n".join(lines), "\n".join(md)


def write_summary(markdown: str) -> None:
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as f:
            f.write(markdown + "\n")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd")
    ap.add_argument("--dry-run", action="store_true", help="no guarda nada en Supabase")
    p = sub.add_parser("probe", help="prueba las fuentes para ISIN / código DGS / ticker")
    p.add_argument("idents", nargs="+")
    args = ap.parse_args(argv)

    if args.cmd == "probe":
        text, md = probe(args.idents)
        print(text)
        write_summary(md)
        return 0

    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SECRET_KEY")
    if not url or not key:
        print("Faltan SUPABASE_URL y/o SUPABASE_SECRET_KEY (en GitHub: Settings > Secrets and variables > Actions).",
              file=sys.stderr)
        return 2
    today = datetime.now(MADRID).date()
    db = SupabaseDb(url, key)
    results = run_update(db, today, args.dry_run)
    try:
        results += run_loans(db, today, args.dry_run)
    except Exception as e:  # p. ej. si aún no se ha añadido la columna 'loan' en Supabase
        results.append(Result("Préstamos", "ERROR", note=str(e)[:300], failure=True))
    try:
        results += run_plans(db, today, args.dry_run)
    except Exception as e:  # p. ej. si aún no se ha añadido la columna 'plan' en Supabase
        results.append(Result("Aportaciones", "ERROR", note=str(e)[:300], failure=True))
    text, md = render(results, today, args.dry_run)
    print(text)
    write_summary(md)
    failures = [r for r in results if r.failure]
    if failures:
        print(f"\n{len(failures)} producto(s) sin precio fiable: " + ", ".join(r.name for r in failures),
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
