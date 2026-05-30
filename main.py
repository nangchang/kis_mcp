#!/usr/bin/env python3
"""
한국투자증권 KIS Developers Open API MCP Server

환경변수 설정 (실전투자):
  KIS_APP_KEY       - 실전 앱키
  KIS_APP_SECRET    - 실전 앱시크리트
  KIS_ACCOUNT_NO    - 종합계좌번호 앞 8자리
  KIS_ACCOUNT_PROD  - 계좌상품코드 (기본값: 01)

환경변수 설정 (모의투자, 선택):
  KIS_PAPER_APP_KEY    - 모의 앱키
  KIS_PAPER_APP_SECRET - 모의 앱시크리트
  KIS_PAPER_ACCOUNT_NO - 모의 계좌번호 앞 8자리
"""

import json
import os
import time
from datetime import datetime
from typing import Optional

import httpx
from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel, Field, ConfigDict

import master as _master

# ─── 서버 초기화 ─────────────────────────────────────────────────────────────

mcp = FastMCP("kis_mcp")

# ─── 상수 ────────────────────────────────────────────────────────────────────

REAL_URL = "https://openapi.koreainvestment.com:9443"
PAPER_URL = "https://openapivts.koreainvestment.com:29443"

# ─── 토큰 캐시 (프로세스 내 메모리) ──────────────────────────────────────────

_token_cache: dict[str, dict] = {}  # {"real": {"token": ..., "expires_at": ...}, "paper": {...}}


def _get_credentials(env: str) -> tuple[str, str, str, str]:
    """환경(real/paper)에 맞는 자격증명 반환. (app_key, app_secret, account_no, prod_cd)"""
    if env == "real":
        app_key = os.environ.get("KIS_APP_KEY", "")
        app_secret = os.environ.get("KIS_APP_SECRET", "")
        account_no = os.environ.get("KIS_ACCOUNT_NO", "")
        prod_cd = os.environ.get("KIS_ACCOUNT_PROD", "01")
        base_url = REAL_URL
    else:
        app_key = os.environ.get("KIS_PAPER_APP_KEY", "")
        app_secret = os.environ.get("KIS_PAPER_APP_SECRET", "")
        account_no = os.environ.get("KIS_PAPER_ACCOUNT_NO", "")
        prod_cd = os.environ.get("KIS_ACCOUNT_PROD", "01")
        base_url = PAPER_URL

    if not app_key or not app_secret:
        prefix = "" if env == "real" else "PAPER_"
        raise ValueError(
            f"KIS_{prefix}APP_KEY 와 KIS_{prefix}APP_SECRET 환경변수를 설정하세요."
        )
    return app_key, app_secret, account_no, prod_cd


def _get_base_url(env: str) -> str:
    return REAL_URL if env == "real" else PAPER_URL


async def _get_access_token(env: str) -> str:
    """토큰을 캐시에서 가져오거나 새로 발급. 만료 5분 전에 재발급."""
    cache = _token_cache.get(env)
    if cache and cache["expires_at"] - time.time() > 300:
        return cache["token"]

    app_key, app_secret, _, _ = _get_credentials(env)
    base_url = _get_base_url(env)

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{base_url}/oauth2/tokenP",
            headers={"Content-Type": "application/json"},
            json={
                "grant_type": "client_credentials",
                "appkey": app_key,
                "appsecret": app_secret,
            },
        )
        resp.raise_for_status()
        data = resp.json()

    token = data["access_token"]
    # 만료 시각 파싱: "2024-01-01 00:00:00" 형식
    try:
        exp_str = data["access_token_token_expired"]
        exp_dt = datetime.strptime(exp_str, "%Y-%m-%d %H:%M:%S")
        expires_at = exp_dt.timestamp()
    except Exception:
        expires_at = time.time() + 86400  # 파싱 실패 시 24시간

    _token_cache[env] = {"token": token, "expires_at": expires_at}
    return token


async def _build_headers(env: str, tr_id: str, tr_cont: str = "") -> dict:
    """API 호출용 헤더 생성."""
    app_key, app_secret, _, _ = _get_credentials(env)
    token = await _get_access_token(env)
    return {
        "Content-Type": "application/json",
        "Accept": "text/plain",
        "charset": "UTF-8",
        "authorization": f"Bearer {token}",
        "appkey": app_key,
        "appsecret": app_secret,
        "tr_id": tr_id,
        "custtype": "P",
        "tr_cont": tr_cont,
    }


async def _get(env: str, path: str, tr_id: str, params: dict, tr_cont: str = "") -> dict:
    """GET 요청. 응답 헤더의 tr_cont 값을 '_tr_cont' 키로 body에 주입해 반환."""
    headers = await _build_headers(env, tr_id, tr_cont)
    base_url = _get_base_url(env)
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(f"{base_url}{path}", headers=headers, params=params)
        resp.raise_for_status()
        data = resp.json()
        # tr_cont는 HTTP 응답 헤더에 있음 (kis_auth.py: res.getHeader().tr_cont)
        data["_tr_cont"] = resp.headers.get("tr_cont", "")
        return data


async def _post(env: str, path: str, tr_id: str, body: dict) -> dict:
    """POST 요청."""
    headers = await _build_headers(env, tr_id)
    base_url = _get_base_url(env)
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{base_url}{path}", headers=headers, content=json.dumps(body)
        )
        resp.raise_for_status()
        return resp.json()


def _check_response(data: dict, context: str) -> str:
    """API 응답 성공 여부 확인 후 에러 메시지 반환."""
    if data.get("rt_cd") != "0":
        msg_cd = data.get("msg_cd", "UNKNOWN")
        msg1 = data.get("msg1", "알 수 없는 오류")
        return f"Error [{msg_cd}]: {msg1} (context: {context})"
    return ""


def _fmt(data: dict) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2)


# ─── Pydantic 입력 모델 ───────────────────────────────────────────────────────

class EnvParam(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    env: str = Field(default="real", description="실전/모의 구분: 'real'(실전, 기본값) 또는 'demo'(모의투자)")


# ─── Tool 1: 국내주식 현재가 조회 ─────────────────────────────────────────────

class DomesticPriceInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    stock_code: str = Field(..., description="종목코드 6자리 (예: '005930' 삼성전자, ETN은 앞에 Q 추가)")
    market: str = Field(default="J", description="시장코드: J(KRX, 기본값), NX(NXT), UN(통합)")
    env: str = Field(default="real", description="'real'(실전) 또는 'demo'(모의)")


@mcp.tool(
    name="kis_get_domestic_stock_price",
    annotations={
        "title": "국내주식 현재가 조회",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def kis_get_domestic_stock_price(params: DomesticPriceInput) -> str:
    """국내주식 현재가 시세를 조회합니다. 실시간이 아닌 단건 조회이며, 현재가·등락률·거래량 등을 반환합니다.

    Args:
        params.stock_code: 종목코드 6자리 (예: '005930' 삼성전자)
        params.market: 시장코드 J(KRX)/NX(NXT)/UN(통합), 기본값 J
        params.env: 'real'(실전) 또는 'demo'(모의), 기본값 'real'

    Returns:
        str: JSON 형식의 현재가 데이터 (현재가, 전일대비, 등락률, 거래량 등)

    Examples:
        - "삼성전자 현재가 알려줘" → stock_code="005930"
        - "애플 주가" → kis_get_overseas_stock_price 사용
        - "모의투자 계좌로 현재가" → env="demo"
    """
    try:
        data = await _get(
            params.env,
            "/uapi/domestic-stock/v1/quotations/inquire-price",
            "FHKST01010100",
            {"FID_COND_MRKT_DIV_CODE": params.market, "FID_INPUT_ISCD": params.stock_code},
        )
        err = _check_response(data, "국내주식 현재가")
        if err:
            return err
        out = data.get("output", {})
        result = {
            "종목코드": params.stock_code,
            "현재가": out.get("stck_prpr"),
            "전일대비": out.get("prdy_vrss"),
            "등락률": out.get("prdy_ctrt"),
            "거래량": out.get("acml_vol"),
            "거래대금": out.get("acml_tr_pbmn"),
            "시가": out.get("stck_oprc"),
            "고가": out.get("stck_hgpr"),
            "저가": out.get("stck_lwpr"),
            "52주_최고": out.get("w52_hgpr"),
            "52주_최저": out.get("w52_lwpr"),
            "시가총액": out.get("hts_avls"),
            "PER": out.get("per"),
            "PBR": out.get("pbr"),
        }
        return _fmt(result)
    except httpx.HTTPStatusError as e:
        return f"Error: HTTP {e.response.status_code} - {e.response.text[:200]}"
    except Exception as e:
        return f"Error: {type(e).__name__}: {e}"


# ─── Tool 2: 국내주식 일별/주별/월별 시세 ────────────────────────────────────

class DomesticChartInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    stock_code: str = Field(..., description="종목코드 6자리 (예: '005930')")
    period: str = Field(default="D", description="기간구분: D(일봉), W(주봉), M(월봉), Y(년봉)")
    start_date: str = Field(default="", description="조회 시작일 YYYYMMDD (예: '20240101', 미입력 시 가능한 최초일부터)")
    end_date: str = Field(default="", description="조회 종료일 YYYYMMDD (예: '20241231', 미입력 시 오늘까지)")
    adjusted: str = Field(default="1", description="수정주가 여부: '1'(반영, 기본값), '0'(미반영)")
    market: str = Field(default="J", description="시장코드: J(KRX, 기본값), NX, UN")
    env: str = Field(default="real", description="'real' 또는 'demo'")


@mcp.tool(
    name="kis_get_domestic_stock_chart",
    annotations={
        "title": "국내주식 일/주/월/년별 시세",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def kis_get_domestic_stock_chart(params: DomesticChartInput) -> str:
    """국내주식의 일별/주별/월별/년별 OHLCV 데이터를 날짜 범위로 조회합니다. 날짜 미지정 시 최근 데이터 반환.

    Args:
        params.stock_code: 종목코드 6자리
        params.period: D(일봉)/W(주봉)/M(월봉)/Y(년봉), 기본값 D
        params.start_date: 시작일 YYYYMMDD (미입력 시 최초일)
        params.end_date: 종료일 YYYYMMDD (미입력 시 오늘)
        params.adjusted: '1'(수정주가 반영, 기본값), '0'(미반영)
        params.env: 'real'/'demo'

    Returns:
        str: JSON 배열 형식의 OHLCV 데이터

    Examples:
        - "삼성전자 최근 주가" → stock_code="005930", period="D"
        - "삼성전자 2024년 월별 차트" → stock_code="005930", period="M", start_date="20240101", end_date="20241231"
        - "삼성전자 지난 1년 일봉" → stock_code="005930", period="D", start_date="20240101"
    """
    try:
        # inquire-daily-itemchartprice: 날짜범위 지정 가능, TR_ID FHKST03010100
        data = await _get(
            params.env,
            "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
            "FHKST03010100",
            {
                "FID_COND_MRKT_DIV_CODE": params.market,
                "FID_INPUT_ISCD": params.stock_code,
                "FID_INPUT_DATE_1": params.start_date,
                "FID_INPUT_DATE_2": params.end_date,
                "FID_PERIOD_DIV_CODE": params.period,
                "FID_ORG_ADJ_PRC": params.adjusted,
            },
        )
        err = _check_response(data, "국내주식 기간별시세")
        if err:
            return err
        # output2에 OHLCV 배열, output1에 종목 요약 정보
        rows = data.get("output2", [])
        result = []
        for r in rows:
            result.append({
                "날짜": r.get("stck_bsop_date"),
                "종가": r.get("stck_clpr"),
                "시가": r.get("stck_oprc"),
                "고가": r.get("stck_hgpr"),
                "저가": r.get("stck_lwpr"),
                "거래량": r.get("acml_vol"),
                "거래대금": r.get("acml_tr_pbmn"),
            })
        return _fmt({"종목코드": params.stock_code, "기간": params.period, "데이터": result})
    except httpx.HTTPStatusError as e:
        return f"Error: HTTP {e.response.status_code} - {e.response.text[:200]}"
    except Exception as e:
        return f"Error: {type(e).__name__}: {e}"


# ─── Tool 3: 국내주식 잔고 조회 ───────────────────────────────────────────────

class DomesticBalanceInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    env: str = Field(default="real", description="'real'(실전) 또는 'demo'(모의)")
    account_no: Optional[str] = Field(default=None, description="계좌번호 앞 8자리 (미입력 시 환경변수 사용)")
    account_prod: Optional[str] = Field(default=None, description="계좌상품코드 2자리 (미입력 시 환경변수 사용)")


@mcp.tool(
    name="kis_get_domestic_balance",
    annotations={
        "title": "국내주식 잔고 조회",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def kis_get_domestic_balance(params: DomesticBalanceInput) -> str:
    """국내주식 계좌의 보유 종목 잔고를 조회합니다. 수량, 평가금액, 수익률 등을 반환합니다.

    Args:
        params.env: 'real'(실전) 또는 'demo'(모의)
        params.account_no: 계좌번호 앞 8자리 (미입력 시 KIS_ACCOUNT_NO 환경변수 사용)
        params.account_prod: 계좌상품코드 (미입력 시 KIS_ACCOUNT_PROD 환경변수 사용)

    Returns:
        str: JSON 형식의 잔고 데이터 (보유종목 목록, 계좌 요약정보)

    Error Handling:
        - KIS_ACCOUNT_NO 환경변수가 없고 account_no 미입력 시 오류
    """
    try:
        _, _, env_acct, env_prod = _get_credentials(params.env)
        cano = params.account_no or env_acct
        prod = params.account_prod or env_prod
        if not cano:
            return "Error: 계좌번호가 필요합니다. KIS_ACCOUNT_NO 환경변수 또는 account_no 파라미터를 설정하세요."

        tr_id = "TTTC8434R" if params.env == "real" else "VTTC8434R"
        request_params = {
            "CANO": cano,
            "ACNT_PRDT_CD": prod,
            "AFHR_FLPR_YN": "N",
            "OFL_YN": "",
            "INQR_DVSN": "02",
            "UNPR_DVSN": "01",
            "FUND_STTL_ICLD_YN": "N",
            "FNCG_AMT_AUTO_RDPT_YN": "N",
            "PRCS_DVSN": "00",
            "CTX_AREA_FK100": "",
            "CTX_AREA_NK100": "",
        }

        holdings = []
        summary = {}
        fk100 = ""
        nk100 = ""
        for _ in range(10):  # 최대 10페이지
            data = await _get(params.env, "/uapi/domestic-stock/v1/trading/inquire-balance", tr_id, {**request_params, "CTX_AREA_FK100": fk100, "CTX_AREA_NK100": nk100})
            err = _check_response(data, "국내주식 잔고")
            if err:
                return err
            for item in data.get("output1", []):
                holdings.append({
                    "종목코드": item.get("pdno"),
                    "종목명": item.get("prdt_name"),
                    "보유수량": item.get("hldg_qty"),
                    "매입단가": item.get("pchs_avg_pric"),
                    "현재가": item.get("prpr"),
                    "평가금액": item.get("evlu_amt"),
                    "손익금액": item.get("evlu_pfls_amt"),
                    "수익률": item.get("evlu_pfls_rt"),
                })
            out2 = data.get("output2", [{}])
            if out2:
                summary = out2[0]
            # tr_cont는 HTTP 응답 헤더에서 옴 (kis_auth.py: res.getHeader().tr_cont)
            tr_cont = data.get("_tr_cont", "")
            if tr_cont not in ("M", "F"):
                break
            fk100 = data.get("ctx_area_fk100", "")
            nk100 = data.get("ctx_area_nk100", "")

        # output2 summary 필드: dnca_tot_amt, pchs_amt_smtl_amt, evlu_amt_smtl_amt, evlu_pfls_smtl_amt
        result = {
            "계좌번호": cano,
            "보유종목": holdings,
            "총_매입금액": summary.get("pchs_amt_smtl_amt"),
            "총_평가금액": summary.get("evlu_amt_smtl_amt"),
            "총_손익금액": summary.get("evlu_pfls_smtl_amt"),
            "예수금": summary.get("dnca_tot_amt"),
        }
        return _fmt(result)
    except httpx.HTTPStatusError as e:
        return f"Error: HTTP {e.response.status_code} - {e.response.text[:200]}"
    except Exception as e:
        return f"Error: {type(e).__name__}: {e}"


# ─── Tool 4: 계좌 자산 현황 ───────────────────────────────────────────────────

class AccountAssetInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    account_no: Optional[str] = Field(default=None, description="계좌번호 앞 8자리 (미입력 시 환경변수 사용)")
    account_prod: Optional[str] = Field(default=None, description="계좌상품코드 (미입력 시 환경변수 사용)")


@mcp.tool(
    name="kis_get_account_assets",
    annotations={
        "title": "투자계좌 자산 현황",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def kis_get_account_assets(params: AccountAssetInput) -> str:
    """투자계좌의 자산 현황을 조회합니다. 자산 유형별 비중 및 총 평가금액을 반환합니다.

    Args:
        params.account_no: 계좌번호 앞 8자리 (미입력 시 KIS_ACCOUNT_NO 환경변수 사용)
        params.account_prod: 계좌상품코드 (미입력 시 KIS_ACCOUNT_PROD 환경변수 사용)

    Returns:
        str: JSON 형식의 자산 현황 (자산유형별 금액, 비중)
    """
    try:
        _, _, env_acct, env_prod = _get_credentials("real")
        cano = params.account_no or env_acct
        prod = params.account_prod or env_prod
        if not cano:
            return "Error: 계좌번호가 필요합니다. KIS_ACCOUNT_NO 환경변수 또는 account_no를 설정하세요."

        data = await _get(
            "real",
            "/uapi/domestic-stock/v1/trading/inquire-account-balance",
            "CTRP6548R",
            {"CANO": cano, "ACNT_PRDT_CD": prod, "INQR_DVSN_1": "", "BSPR_BF_DT_APLY_YN": ""},
        )
        err = _check_response(data, "계좌 자산 현황")
        if err:
            return err

        output1 = data.get("output1", [])
        output2 = data.get("output2", {})
        return _fmt({"자산_유형별": output1, "계좌_요약": output2})
    except httpx.HTTPStatusError as e:
        return f"Error: HTTP {e.response.status_code} - {e.response.text[:200]}"
    except Exception as e:
        return f"Error: {type(e).__name__}: {e}"


# ─── Tool 5: 국내주식 현금 주문 ───────────────────────────────────────────────

class DomesticOrderInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    stock_code: str = Field(..., description="종목코드 6자리 (예: '005930')")
    side: str = Field(..., description="매수/매도: 'buy'(매수) 또는 'sell'(매도)")
    quantity: str = Field(..., description="주문수량 (문자열, 예: '10')")
    price: str = Field(..., description="주문단가 (문자열, 예: '75000', 시장가이면 '0')")
    order_type: str = Field(default="00", description="주문구분: '00'(지정가, 기본값), '01'(시장가), '02'(조건부지정가), '03'(최유리지정가)")
    exchange: str = Field(default="KRX", description="거래소: 'KRX'(한국거래소, 기본값), 'NXT'(대체거래소)")
    env: str = Field(default="demo", description="'demo'(모의, 기본값) 또는 'real'(실전, 실제 자금 사용 주의!)")
    account_no: Optional[str] = Field(default=None, description="계좌번호 앞 8자리 (미입력 시 환경변수 사용)")
    account_prod: Optional[str] = Field(default=None, description="계좌상품코드 2자리 (미입력 시 환경변수 사용)")


@mcp.tool(
    name="kis_place_domestic_order",
    annotations={
        "title": "국내주식 현금 주문",
        "readOnlyHint": False,
        "destructiveHint": True,
        "idempotentHint": False,
        "openWorldHint": True,
    },
)
async def kis_place_domestic_order(params: DomesticOrderInput) -> str:
    """국내주식 현금 매수/매도 주문을 제출합니다. 실전 환경에서는 실제 자금이 사용됩니다.

    Args:
        params.stock_code: 종목코드 6자리
        params.side: 'buy'(매수) 또는 'sell'(매도)
        params.quantity: 주문수량 문자열
        params.price: 주문단가 문자열 (시장가이면 '0')
        params.order_type: '00'(지정가, 기본값), '01'(시장가) 등
        params.exchange: 'KRX'(기본값) 또는 'NXT'
        params.env: 'real'(실전, 주의!) 또는 'demo'(모의)
        params.account_no: 계좌번호 앞 8자리 (미입력 시 환경변수 사용)
        params.account_prod: 계좌상품코드 (미입력 시 환경변수 사용)

    Returns:
        str: JSON 형식의 주문 결과 (주문번호 등)

    Warning:
        env='real'인 경우 실제 자금이 사용됩니다. 테스트는 env='demo'를 사용하세요.
    """
    try:
        _, _, env_acct, env_prod = _get_credentials(params.env)
        cano = params.account_no or env_acct
        prod = params.account_prod or env_prod
        if not cano:
            return "Error: 계좌번호가 필요합니다."

        if params.env == "real":
            tr_id = "TTTC0011U" if params.side == "sell" else "TTTC0012U"
        else:
            tr_id = "VTTC0011U" if params.side == "sell" else "VTTC0012U"

        body = {
            "CANO": cano,
            "ACNT_PRDT_CD": prod,
            "PDNO": params.stock_code,
            "ORD_DVSN": params.order_type,
            "ORD_QTY": params.quantity,
            "ORD_UNPR": params.price,
            "EXCG_ID_DVSN_CD": params.exchange,
            "SLL_TYPE": "01" if params.side == "sell" else "",
            "CNDT_PRIC": "",
        }
        data = await _post(params.env, "/uapi/domestic-stock/v1/trading/order-cash", tr_id, body)
        err = _check_response(data, "국내주식 주문")
        if err:
            return err
        out = data.get("output", {})
        return _fmt({
            "결과": "주문 완료",
            "환경": params.env,
            "종목코드": params.stock_code,
            "매수매도": params.side,
            "주문수량": params.quantity,
            "주문단가": params.price,
            "주문번호": out.get("odno"),
            "주문시각": out.get("ord_tmd"),
        })
    except httpx.HTTPStatusError as e:
        return f"Error: HTTP {e.response.status_code} - {e.response.text[:200]}"
    except Exception as e:
        return f"Error: {type(e).__name__}: {e}"


# ─── Tool 6: 국내주식 주문 정정/취소 ─────────────────────────────────────────

class DomesticReviseInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    action: str = Field(..., description="'revise'(정정) 또는 'cancel'(취소)")
    org_order_no: str = Field(..., description="원주문번호")
    org_order_orgno: str = Field(..., description="한국거래소전송주문조직번호 (원주문 결과의 krx_fwdg_ord_orgno)")
    order_type: str = Field(..., description="주문구분 (원주문과 동일하게 입력, 예: '00')")
    quantity: str = Field(default="0", description="주문수량 ('0'이면 잔량 전체)")
    price: str = Field(default="0", description="정정 주문단가 (취소 시 '0')")
    all_qty: str = Field(default="Y", description="잔량전부여부: 'Y'(전량, 기본값), 'N'(일부)")
    exchange: str = Field(default="KRX", description="거래소: 'KRX'(기본값), 'NXT', 'SOR'")
    env: str = Field(default="demo", description="'demo'(모의, 기본값) 또는 'real'(실전, 실제 자금 사용 주의!)")
    account_no: Optional[str] = Field(default=None, description="계좌번호 앞 8자리")
    account_prod: Optional[str] = Field(default=None, description="계좌상품코드")


@mcp.tool(
    name="kis_revise_or_cancel_domestic_order",
    annotations={
        "title": "국내주식 주문 정정/취소",
        "readOnlyHint": False,
        "destructiveHint": True,
        "idempotentHint": False,
        "openWorldHint": True,
    },
)
async def kis_revise_or_cancel_domestic_order(params: DomesticReviseInput) -> str:
    """미체결 국내주식 주문을 정정하거나 취소합니다. 이미 체결된 주문은 취소 불가합니다.

    Args:
        params.action: 'revise'(정정) 또는 'cancel'(취소)
        params.org_order_no: 원주문번호 (주문 접수 시 반환된 odno)
        params.org_order_orgno: 한국거래소전송주문조직번호 (원주문의 krx_fwdg_ord_orgno)
        params.order_type: 주문구분 (원주문과 동일, 예: '00')
        params.quantity: 수량 ('0'이면 all_qty=Y 적용)
        params.price: 정정 단가 (취소 시 '0')
        params.all_qty: 'Y'(잔량 전체, 기본값), 'N'(일부)
        params.env: 'real'(실전) 또는 'demo'(모의)

    Returns:
        str: JSON 형식의 정정/취소 결과
    """
    try:
        _, _, env_acct, env_prod = _get_credentials(params.env)
        cano = params.account_no or env_acct
        prod = params.account_prod or env_prod
        if not cano:
            return "Error: 계좌번호가 필요합니다."

        tr_id = "TTTC0013U" if params.env == "real" else "VTTC0013U"
        rvse_cd = "01" if params.action == "revise" else "02"

        body = {
            "CANO": cano,
            "ACNT_PRDT_CD": prod,
            "KRX_FWDG_ORD_ORGNO": params.org_order_orgno,
            "ORGN_ODNO": params.org_order_no,
            "ORD_DVSN": params.order_type,
            "RVSE_CNCL_DVSN_CD": rvse_cd,
            "ORD_QTY": params.quantity,
            "ORD_UNPR": params.price,
            "QTY_ALL_ORD_YN": params.all_qty,
            "EXCG_ID_DVSN_CD": params.exchange,
        }
        data = await _post(params.env, "/uapi/domestic-stock/v1/trading/order-rvsecncl", tr_id, body)
        err = _check_response(data, "주문 정정/취소")
        if err:
            return err
        out = data.get("output", {})
        return _fmt({
            "결과": f"{'정정' if params.action == 'revise' else '취소'} 완료",
            "원주문번호": params.org_order_no,
            "신규주문번호": out.get("odno"),
            "주문시각": out.get("ord_tmd"),
        })
    except httpx.HTTPStatusError as e:
        return f"Error: HTTP {e.response.status_code} - {e.response.text[:200]}"
    except Exception as e:
        return f"Error: {type(e).__name__}: {e}"


# ─── Tool 7: 해외주식 현재가 조회 ─────────────────────────────────────────────

class OverseasPriceInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    symbol: str = Field(..., description="종목코드 (예: 'AAPL', 'TSLA', '005930' 등)")
    exchange: str = Field(..., description="거래소코드: NAS(나스닥), NYSE(뉴욕), AMEX, SEHK(홍콩), SHAA(중국상해), SZAA(중국심천), TKSE(일본), HASE(베트남하노이), VNSE(베트남호치민)")
    env: str = Field(default="real", description="'real' 또는 'demo'")


@mcp.tool(
    name="kis_get_overseas_stock_price",
    annotations={
        "title": "해외주식 현재가 조회",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def kis_get_overseas_stock_price(params: OverseasPriceInput) -> str:
    """해외주식 현재 체결가를 조회합니다. 미국, 홍콩, 중국, 일본, 베트남 주식 지원.

    Args:
        params.symbol: 종목코드 (예: 'AAPL', 'TSLA')
        params.exchange: 거래소코드 (NAS/NYSE/AMEX/SEHK/SHAA/SZAA/TKSE/HASE/VNSE)
        params.env: 'real'(실전, 기본값) 또는 'demo'(모의)

    Returns:
        str: JSON 형식의 현재가 데이터 (현재가, 전일대비, 등락률, 거래량 등)

    Examples:
        - "애플 주가" → symbol="AAPL", exchange="NAS"
        - "테슬라 현재가" → symbol="TSLA", exchange="NAS"
        - "삼성전자 홍콩 주가" → symbol="005930", exchange="SEHK"
    """
    try:
        data = await _get(
            params.env,
            "/uapi/overseas-price/v1/quotations/price",
            "HHDFS00000300",
            {"AUTH": "", "EXCD": params.exchange, "SYMB": params.symbol},
        )
        err = _check_response(data, "해외주식 현재가")
        if err:
            return err
        out = data.get("output", {})
        # 해외주식 현재체결가 API output 필드: rsym, zdiv, base, pvol, last, sign, diff, rate, tvol, tamt, ordy
        return _fmt({
            "종목코드": params.symbol,
            "거래소": params.exchange,
            "현재가": out.get("last"),
            "전일종가": out.get("base"),
            "전일대비": out.get("diff"),
            "등락률": out.get("rate"),
            "거래량": out.get("tvol"),
            "거래대금": out.get("tamt"),
            "전일거래량": out.get("pvol"),
            "매수가능여부": out.get("ordy"),
        })
    except httpx.HTTPStatusError as e:
        return f"Error: HTTP {e.response.status_code} - {e.response.text[:200]}"
    except Exception as e:
        return f"Error: {type(e).__name__}: {e}"


# ─── Tool 8: 해외주식 일별 시세 ───────────────────────────────────────────────

class OverseasChartInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    symbol: str = Field(..., description="종목코드 (예: 'AAPL')")
    exchange: str = Field(..., description="거래소코드 (NAS/NYSE/AMEX/SEHK 등)")
    period: str = Field(default="0", description="기간: '0'(일봉, 기본값), '1'(주봉), '2'(월봉)")
    env: str = Field(default="real", description="'real' 또는 'demo'")


@mcp.tool(
    name="kis_get_overseas_stock_chart",
    annotations={
        "title": "해외주식 일/주/월별 시세",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def kis_get_overseas_stock_chart(params: OverseasChartInput) -> str:
    """해외주식의 일별/주별/월별 OHLCV 데이터를 조회합니다.

    Args:
        params.symbol: 종목코드
        params.exchange: 거래소코드
        params.period: '0'(일봉, 기본값), '1'(주봉), '2'(월봉)
        params.env: 'real'/'demo'

    Returns:
        str: JSON 배열 형식의 OHLCV 데이터

    Examples:
        - "AAPL 최근 주가 추이" → symbol="AAPL", exchange="NAS", period="0"
    """
    try:
        data = await _get(
            params.env,
            "/uapi/overseas-price/v1/quotations/dailyprice",
            "HHDFS76240000",
            {
                "AUTH": "",
                "EXCD": params.exchange,
                "SYMB": params.symbol,
                "GUBN": params.period,
                "BYMD": "",
                "MODP": "0",
            },
        )
        err = _check_response(data, "해외주식 일별시세")
        if err:
            return err
        rows = data.get("output2", [])
        result = []
        for r in rows:
            result.append({
                "날짜": r.get("xymd"),
                "종가": r.get("clos"),
                "시가": r.get("open"),
                "고가": r.get("high"),
                "저가": r.get("low"),
                "거래량": r.get("tvol"),
            })
        return _fmt({"종목코드": params.symbol, "거래소": params.exchange, "기간": params.period, "데이터": result})
    except httpx.HTTPStatusError as e:
        return f"Error: HTTP {e.response.status_code} - {e.response.text[:200]}"
    except Exception as e:
        return f"Error: {type(e).__name__}: {e}"


# ─── Tool 9: 해외주식 잔고 조회 ───────────────────────────────────────────────

class OverseasBalanceInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    exchange: str = Field(default="NASD", description="거래소코드: 실전=NASD(미국전체)/SEHK/SHAA/SZAA/TKSE/HASE/VNSE, 모의=NASD/NYSE/AMEX/SEHK/SHAA/SZAA/TKSE/HASE/VNSE")
    currency: str = Field(default="USD", description="통화코드: USD(미국), HKD(홍콩), CNY(중국), JPY(일본), VND(베트남)")
    env: str = Field(default="real", description="'real' 또는 'demo'")
    account_no: Optional[str] = Field(default=None, description="계좌번호 앞 8자리")
    account_prod: Optional[str] = Field(default=None, description="계좌상품코드")


@mcp.tool(
    name="kis_get_overseas_balance",
    annotations={
        "title": "해외주식 잔고 조회",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def kis_get_overseas_balance(params: OverseasBalanceInput) -> str:
    """해외주식 계좌의 보유 종목 잔고를 조회합니다.

    Args:
        params.exchange: 거래소코드 (기본값: NASD = 미국 전체)
        params.currency: 통화코드 (기본값: USD)
        params.env: 'real'/'demo'
        params.account_no: 계좌번호 앞 8자리
        params.account_prod: 계좌상품코드

    Returns:
        str: JSON 형식의 해외주식 잔고 데이터
    """
    try:
        _, _, env_acct, env_prod = _get_credentials(params.env)
        cano = params.account_no or env_acct
        prod = params.account_prod or env_prod
        if not cano:
            return "Error: 계좌번호가 필요합니다."

        tr_id = "TTTS3012R" if params.env == "real" else "VTTS3012R"

        holdings = []
        summary = {}
        fk200 = ""
        nk200 = ""
        for _ in range(10):
            req_params = {
                "CANO": cano,
                "ACNT_PRDT_CD": prod,
                "OVRS_EXCG_CD": params.exchange,
                "TR_CRCY_CD": params.currency,
                "CTX_AREA_FK200": fk200,
                "CTX_AREA_NK200": nk200,
            }
            data = await _get(params.env, "/uapi/overseas-stock/v1/trading/inquire-balance", tr_id, req_params)
            err = _check_response(data, "해외주식 잔고")
            if err:
                return err

            out1 = data.get("output1", [])
            # output1 = 보유종목 배열, output2 = 단일 요약 객체
            if isinstance(out1, list):
                for item in out1:
                    if not item.get("ovrs_pdno"):  # 빈 행 스킵
                        continue
                    holdings.append({
                        "종목코드": item.get("ovrs_pdno"),
                        "종목명": item.get("ovrs_item_name"),
                        "거래소": item.get("ovrs_excg_cd"),
                        "통화": item.get("tr_crcy_cd"),
                        "보유수량": item.get("ovrs_cblc_qty"),
                        "매입단가": item.get("pchs_avg_pric"),
                        "현재가": item.get("now_pric2"),
                        "평가금액": item.get("ovrs_stck_evlu_amt"),
                        "손익금액": item.get("frcr_evlu_pfls_amt"),
                        "수익률": item.get("evlu_pfls_rt"),
                    })

            out2 = data.get("output2", {})
            if isinstance(out2, dict) and out2:
                summary = out2

            # tr_cont는 HTTP 응답 헤더에서 옴
            tr_cont = data.get("_tr_cont", "")
            if tr_cont not in ("M", "F"):
                break
            fk200 = data.get("ctx_area_fk200", "")
            nk200 = data.get("ctx_area_nk200", "")

        return _fmt({
            "계좌번호": cano,
            "거래소": params.exchange,
            "통화": params.currency,
            "보유종목": holdings,
            "총_평가금액": summary.get("tot_evlu_pfls_amt") or summary.get("ovrs_tot_pfls"),
        })
    except httpx.HTTPStatusError as e:
        return f"Error: HTTP {e.response.status_code} - {e.response.text[:200]}"
    except Exception as e:
        return f"Error: {type(e).__name__}: {e}"


# ─── Tool 10: 해외주식 주문 ───────────────────────────────────────────────────

class OverseasOrderInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    symbol: str = Field(..., description="종목코드 (예: 'AAPL')")
    exchange: str = Field(..., description="거래소코드: NASD(나스닥), NYSE(뉴욕), AMEX, SEHK(홍콩), SHAA(중국상해), SZAA(중국심천), TKSE(일본), HASE(베트남하노이), VNSE(베트남호치민)")
    side: str = Field(..., description="'buy'(매수) 또는 'sell'(매도)")
    quantity: str = Field(..., description="주문수량 (문자열)")
    price: str = Field(..., description="주문단가 (문자열, 시장가이면 '0')")
    order_type: str = Field(default="00", description="주문구분: '00'(지정가, 기본값)")
    env: str = Field(default="demo", description="'demo'(모의, 기본값) 또는 'real'(실전, 실제 자금 사용 주의!)")
    account_no: Optional[str] = Field(default=None, description="계좌번호 앞 8자리")
    account_prod: Optional[str] = Field(default=None, description="계좌상품코드")

    # TR_ID 매핑 (거래소별)
    _BUY_TR: dict = {
        "NASD": "TTTT1002U", "NYSE": "TTTT1002U", "AMEX": "TTTT1002U",
        "SEHK": "TTTS1002U", "SHAA": "TTTS0202U", "SZAA": "TTTS0305U",
        "TKSE": "TTTS0308U", "HASE": "TTTS0311U", "VNSE": "TTTS0311U",
    }
    _SELL_TR: dict = {
        "NASD": "TTTT1006U", "NYSE": "TTTT1006U", "AMEX": "TTTT1006U",
        "SEHK": "TTTS1001U", "SHAA": "TTTS1005U", "SZAA": "TTTS0304U",
        "TKSE": "TTTS0307U", "HASE": "TTTS0310U", "VNSE": "TTTS0310U",
    }


@mcp.tool(
    name="kis_place_overseas_order",
    annotations={
        "title": "해외주식 주문",
        "readOnlyHint": False,
        "destructiveHint": True,
        "idempotentHint": False,
        "openWorldHint": True,
    },
)
async def kis_place_overseas_order(params: OverseasOrderInput) -> str:
    """해외주식 매수/매도 주문을 제출합니다. 실전 환경에서는 실제 자금이 사용됩니다.

    Args:
        params.symbol: 종목코드
        params.exchange: 거래소코드 (NASD/NYSE/AMEX/SEHK/SHAA/SZAA/TKSE/HASE/VNSE)
        params.side: 'buy'(매수) 또는 'sell'(매도)
        params.quantity: 수량 문자열
        params.price: 단가 문자열
        params.order_type: '00'(지정가, 기본값)
        params.env: 'real'(실전, 주의!) 또는 'demo'(모의)

    Returns:
        str: JSON 형식의 주문 결과

    Warning:
        env='real'인 경우 실제 자금이 사용됩니다.
    """
    try:
        _, _, env_acct, env_prod = _get_credentials(params.env)
        cano = params.account_no or env_acct
        prod = params.account_prod or env_prod
        if not cano:
            return "Error: 계좌번호가 필요합니다."

        BUY_TR = {
            "NASD": "TTTT1002U", "NYSE": "TTTT1002U", "AMEX": "TTTT1002U",
            "SEHK": "TTTS1002U", "SHAA": "TTTS0202U", "SZAA": "TTTS0305U",
            "TKSE": "TTTS0308U", "HASE": "TTTS0311U", "VNSE": "TTTS0311U",
        }
        SELL_TR = {
            "NASD": "TTTT1006U", "NYSE": "TTTT1006U", "AMEX": "TTTT1006U",
            "SEHK": "TTTS1001U", "SHAA": "TTTS1005U", "SZAA": "TTTS0304U",
            "TKSE": "TTTS0307U", "HASE": "TTTS0310U", "VNSE": "TTTS0310U",
        }
        tr_map = BUY_TR if params.side == "buy" else SELL_TR
        tr_id = tr_map.get(params.exchange)
        if not tr_id:
            return f"Error: 지원하지 않는 거래소입니다: {params.exchange}"

        if params.env == "demo":
            tr_id = "V" + tr_id[1:]

        sll_type = "00" if params.side == "sell" else ""
        body = {
            "CANO": cano,
            "ACNT_PRDT_CD": prod,
            "OVRS_EXCG_CD": params.exchange,
            "PDNO": params.symbol,
            "ORD_QTY": params.quantity,
            "OVRS_ORD_UNPR": params.price,
            "CTAC_TLNO": "",
            "MGCO_APTM_ODNO": "",
            "SLL_TYPE": sll_type,
            "ORD_SVR_DVSN_CD": "0",
            "ORD_DVSN": params.order_type,
        }
        data = await _post(params.env, "/uapi/overseas-stock/v1/trading/order", tr_id, body)
        err = _check_response(data, "해외주식 주문")
        if err:
            return err
        out = data.get("output", {})
        return _fmt({
            "결과": "주문 완료",
            "환경": params.env,
            "종목코드": params.symbol,
            "거래소": params.exchange,
            "매수매도": params.side,
            "주문수량": params.quantity,
            "주문단가": params.price,
            "주문번호": out.get("odno"),
            "주문시각": out.get("ord_tmd"),
        })
    except httpx.HTTPStatusError as e:
        return f"Error: HTTP {e.response.status_code} - {e.response.text[:200]}"
    except Exception as e:
        return f"Error: {type(e).__name__}: {e}"


# ─── Tool 11: 종목 검색 ───────────────────────────────────────────────────────

class SearchStockInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    query: str = Field(..., description="검색어: 종목코드(예: '005930') 또는 종목명(예: '삼성전자', 'AAPL', '애플'). 띄어쓰기 무시.")
    markets: Optional[list[str]] = Field(
        default=None,
        description="검색 대상 market 목록 (기본값: 전체). 가능한 값: KOSPI, KOSDAQ, NAS(나스닥), NYS(NYSE), AMS(AMEX), HKS(홍콩), TSE(일본), SHS(중국상해), SZS(중국심천), HNX(베트남하노이), HSX(베트남호치민)"
    )
    limit: int = Field(default=10, description="최대 반환 수 (기본값 10)", ge=1, le=50)


@mcp.tool(
    name="kis_search_stock",
    annotations={
        "title": "종목 검색 (코드·이름)",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False,
    },
)
async def kis_search_stock(params: SearchStockInput) -> str:
    """종목코드 또는 종목명으로 종목을 검색합니다. 국내(KOSPI/KOSDAQ)·해외(미국·홍콩·일본 등) 전 종목 지원.

    마스터 데이터는 하루 1회 자동 갱신됩니다 (첫 호출 시 다운로드, 수 초 소요).

    Args:
        params.query: 종목코드 또는 종목명 (예: '삼성전자', '005930', 'AAPL', '애플')
        params.markets: 특정 시장만 검색할 경우 지정 (기본값: 전체)
        params.limit: 최대 결과 수 (기본값: 10)

    Returns:
        str: JSON 형식의 검색 결과 (code, name, market, exchange)

    Examples:
        - "삼성전자 종목코드" → query="삼성전자"
        - "애플 코드" → query="애플" 또는 query="AAPL"
        - "005930 종목명" → query="005930"
        - "나스닥에서 테슬라 찾아줘" → query="테슬라", markets=["NAS"]
    """
    target_markets = params.markets or _master.ALL_MARKETS
    refresh_status = await _master.ensure_fresh(target_markets)

    stale_markets = [m for m, s in refresh_status.items() if s.startswith("실패")]
    results = _master.search(params.query, target_markets, params.limit)

    response: dict = {"검색어": params.query, "결과수": len(results), "결과": results}
    if stale_markets:
        response["경고"] = f"다음 시장 데이터 갱신 실패 (검색 결과 제한될 수 있음): {stale_markets}"
    return _fmt(response)


# ─── Tool 12: 마스터 DB 현황 ─────────────────────────────────────────────────

@mcp.tool(
    name="kis_master_status",
    annotations={
        "title": "종목 마스터 DB 현황",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False,
    },
)
async def kis_master_status() -> str:
    """로컬 종목 마스터 DB의 시장별 종목 수와 마지막 갱신일을 조회합니다.

    Returns:
        str: JSON 형식의 market별 종목 수 및 갱신일
    """
    stats = _master.get_db_stats()
    return _fmt({"마스터_DB": stats, "DB_경로": str(_master.DB_PATH)})


# ─── 진입점 ───────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    mcp.run()
