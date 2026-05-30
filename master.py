"""
KIS 종목 마스터 파일 관리

마스터 파일을 하루 1회 다운로드해 ~/.kis_mcp/master.db 에 캐시합니다.
국내: KOSPI/KOSDAQ (고정폭 CP949), 해외: NAS/NYS/AMS/HKS/TSE (TSV)
"""

import io
import logging
import sqlite3
import zipfile
from datetime import date
from pathlib import Path

import httpx

log = logging.getLogger(__name__)

DB_PATH = Path.home() / ".kis_mcp" / "master.db"

# 국내주식 마스터: (URL, 이름 끝 고정폭 오프셋)
# 오프셋은 파일 맨 끝 고정폭 섹션의 바이트 수. name = row[21 : len(row)-offset]
_DOMESTIC = {
    "KOSDAQ": ("https://new.real.download.dws.co.kr/common/master/kosdaq_code.mst.zip", 222),
    "KOSPI":  ("https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip",  228),
}

# 해외주식 마스터: TSV, symbol=col[4], korea_name=col[6]
_OVERSEAS = {
    "NAS": "https://new.real.download.dws.co.kr/common/master/nasmst.cod.zip",
    "NYS": "https://new.real.download.dws.co.kr/common/master/nysmst.cod.zip",
    "AMS": "https://new.real.download.dws.co.kr/common/master/amsmst.cod.zip",
    "HKS": "https://new.real.download.dws.co.kr/common/master/hksmst.cod.zip",
    "TSE": "https://new.real.download.dws.co.kr/common/master/tsemst.cod.zip",
    "SHS": "https://new.real.download.dws.co.kr/common/master/shsmst.cod.zip",
    "SZS": "https://new.real.download.dws.co.kr/common/master/szsmst.cod.zip",
    "HNX": "https://new.real.download.dws.co.kr/common/master/hnxmst.cod.zip",
    "HSX": "https://new.real.download.dws.co.kr/common/master/hsxmst.cod.zip",
}

ALL_MARKETS = list(_DOMESTIC) + list(_OVERSEAS)


# ─── DB 헬퍼 ──────────────────────────────────────────────────────────────────

def _conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(DB_PATH)
    c.executescript("""
        CREATE TABLE IF NOT EXISTS stocks (
            code    TEXT NOT NULL,
            name    TEXT NOT NULL,
            market  TEXT NOT NULL,
            exchange TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_stocks_code   ON stocks(code);
        CREATE INDEX IF NOT EXISTS idx_stocks_name   ON stocks(name);
        CREATE INDEX IF NOT EXISTS idx_stocks_market ON stocks(market);
        CREATE TABLE IF NOT EXISTS meta (
            market       TEXT PRIMARY KEY,
            updated_date TEXT NOT NULL
        );
    """)
    c.commit()
    return c


def _is_stale(market: str) -> bool:
    try:
        c = _conn()
        row = c.execute("SELECT updated_date FROM meta WHERE market=?", (market,)).fetchone()
        c.close()
        return not row or row[0] != date.today().isoformat()
    except Exception:
        return True


# ─── 다운로드 & 파싱 ─────────────────────────────────────────────────────────

async def _download_zip(url: str) -> bytes:
    """ZIP 다운로드 → 첫 번째 파일 원본 bytes 반환."""
    async with httpx.AsyncClient(timeout=60, verify=False) as client:
        resp = await client.get(url)
        resp.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        return zf.read(zf.namelist()[0])


def _decode(raw: bytes) -> str:
    for enc in ("cp949", "euc-kr", "utf-8"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="ignore")


def _parse_domestic(raw: bytes, market: str, offset: int) -> list[tuple]:
    """
    고정폭 CP949 국내주식 마스터 파싱.
    레이아웃: short_code(9) + standard_code(12) + korean_name(가변) + 고정폭(offset bytes)
    """
    records = []
    for line in _decode(raw).splitlines():
        if len(line) <= 21 + offset:
            continue
        code = line[0:9].rstrip()
        name = line[21:len(line) - offset].strip().replace(" ", "")
        if code and name:
            records.append((code, name, market, None))
    return records


def _parse_overseas(raw: bytes, exchange: str) -> list[tuple]:
    """TSV 해외주식 마스터 파싱. symbol=col[4], korea_name=col[6].
    market=exchange 코드로 저장 (NAS, NYS 등)."""
    records = []
    for line in _decode(raw).splitlines():
        cols = line.split("\t")
        if len(cols) < 7:
            continue
        code = cols[4].strip()
        name = cols[6].strip().replace(" ", "")
        if code and name:
            records.append((code, name, exchange, exchange))
    return records


# ─── 공개 API ─────────────────────────────────────────────────────────────────

async def refresh(market: str) -> int:
    """지정 market의 마스터 데이터를 새로고침. 저장된 레코드 수 반환."""
    if market in _DOMESTIC:
        url, offset = _DOMESTIC[market]
        raw = await _download_zip(url)
        records = _parse_domestic(raw, market, offset)
    elif market in _OVERSEAS:
        raw = await _download_zip(_OVERSEAS[market])
        records = _parse_overseas(raw, market)
    else:
        raise ValueError(f"알 수 없는 market: {market}")

    c = _conn()
    # 현재 market 삭제 + 이전 포맷(market="OVERSEAS")으로 저장된 잔여 데이터도 정리
    c.execute("DELETE FROM stocks WHERE market=? OR (market='OVERSEAS' AND exchange=?)", (market, market))
    c.executemany("INSERT INTO stocks(code,name,market,exchange) VALUES(?,?,?,?)", records)
    c.execute("INSERT OR REPLACE INTO meta(market,updated_date) VALUES(?,?)",
              (market, date.today().isoformat()))
    c.commit()
    c.close()
    log.info("master refresh: %s → %d records", market, len(records))
    return len(records)


async def ensure_fresh(markets: list[str]) -> dict[str, str]:
    """stale한 market만 refresh. {market: 상태메시지} 반환."""
    result = {}
    for m in markets:
        if _is_stale(m):
            try:
                n = await refresh(m)
                result[m] = f"갱신 ({n}종목)"
            except Exception as e:
                result[m] = f"실패: {e}"
        else:
            result[m] = "최신"
    return result


def search(query: str, markets: list[str] | None = None, limit: int = 10) -> list[dict]:
    """
    종목코드(정확) 또는 종목명(정확→앞글자→포함) 순으로 검색.
    markets 지정 시 해당 market만 검색.
    """
    q = query.replace(" ", "")
    c = _conn()

    def _run(sql: str, params: tuple) -> list:
        return c.execute(sql, params).fetchall()

    market_clause = ""
    market_params: tuple = ()
    if markets:
        placeholders = ",".join("?" * len(markets))
        market_clause = f" AND market IN ({placeholders})"
        market_params = tuple(markets)

    base = f"SELECT code,name,market,exchange FROM stocks WHERE {{cond}}{market_clause} LIMIT ?"

    for cond, val in [
        ("code=?",       q),
        ("name=?",       q),
        ("name LIKE ?",  f"{q}%"),
        ("name LIKE ?",  f"%{q}%"),
    ]:
        rows = _run(base.format(cond=cond), (val, *market_params, limit))
        if rows:
            break

    c.close()
    return [{"code": r[0], "name": r[1], "market": r[2], "exchange": r[3]} for r in rows]


def get_db_stats() -> dict:
    """DB에 저장된 market별 종목 수 반환."""
    c = _conn()
    rows = c.execute("SELECT market, COUNT(*) FROM stocks GROUP BY market ORDER BY market").fetchall()
    meta = c.execute("SELECT market, updated_date FROM meta").fetchall()
    c.close()
    counts = {r[0]: r[1] for r in rows}
    dates  = {r[0]: r[1] for r in meta}
    return {
        m: {"count": counts.get(m, 0), "updated": dates.get(m, "없음")}
        for m in ALL_MARKETS
    }
