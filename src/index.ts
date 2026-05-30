/**
 * 한국투자증권 KIS Developers Open API MCP Server
 *
 * 환경변수 (실전투자):
 *   KIS_APP_KEY, KIS_APP_SECRET, KIS_ACCOUNT_NO, KIS_ACCOUNT_PROD (기본값: 01)
 *
 * 환경변수 (모의투자):
 *   KIS_PAPER_APP_KEY, KIS_PAPER_APP_SECRET, KIS_PAPER_ACCOUNT_NO
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fetch } from "undici";
import { fileURLToPath } from "node:url";
import * as master from "./master.js";

const REAL_URL = "https://openapi.koreainvestment.com:9443";
const PAPER_URL = "https://openapivts.koreainvestment.com:29443";

// ─── 토큰 캐시 ───────────────────────────────────────────────────────────────

interface TokenEntry {
  token: string;
  expiresAt: number; // Unix timestamp (seconds)
}
const tokenCache: Record<string, TokenEntry> = {};

export function getCredentials(env: string): {
  appKey: string;
  appSecret: string;
  accountNo: string;
  prodCd: string;
} {
  const isReal = env === "real";
  const prefix = isReal ? "" : "PAPER_";
  const appKey = process.env[`KIS_${prefix}APP_KEY`] ?? "";
  const appSecret = process.env[`KIS_${prefix}APP_SECRET`] ?? "";
  const accountNo = process.env[`KIS_${prefix}ACCOUNT_NO`] ?? "";
  const prodCd = process.env.KIS_ACCOUNT_PROD ?? "01";
  if (!appKey || !appSecret) {
    throw new Error(`KIS_${prefix}APP_KEY 와 KIS_${prefix}APP_SECRET 환경변수를 설정하세요.`);
  }
  return { appKey, appSecret, accountNo, prodCd };
}

function baseUrl(env: string): string {
  return env === "real" ? REAL_URL : PAPER_URL;
}

export async function getAccessToken(env: string): Promise<string> {
  const cached = tokenCache[env];
  if (cached && cached.expiresAt - Date.now() / 1000 > 300) return cached.token;

  const { appKey, appSecret } = getCredentials(env);
  const resp = await fetch(`${baseUrl(env)}/oauth2/tokenP`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", appkey: appKey, appsecret: appSecret }),
  });
  if (!resp.ok) throw new Error(`Token 발급 실패: HTTP ${resp.status}`);

  const data = (await resp.json()) as {
    access_token: string;
    access_token_token_expired: string;
  };

  let expiresAt: number;
  try {
    expiresAt = new Date(data.access_token_token_expired.replace(" ", "T")).getTime() / 1000;
  } catch {
    expiresAt = Date.now() / 1000 + 86400;
  }
  tokenCache[env] = { token: data.access_token, expiresAt };
  return data.access_token;
}

async function buildHeaders(env: string, trId: string, trCont = ""): Promise<Record<string, string>> {
  const { appKey, appSecret } = getCredentials(env);
  const token = await getAccessToken(env);
  return {
    "Content-Type": "application/json",
    Accept: "text/plain",
    charset: "UTF-8",
    authorization: `Bearer ${token}`,
    appkey: appKey,
    appsecret: appSecret,
    tr_id: trId,
    custtype: "P",
    tr_cont: trCont,
  };
}

type ApiData = Record<string, unknown>;

export async function apiGet(
  env: string,
  apiPath: string,
  trId: string,
  params: Record<string, string>,
  trCont = "",
): Promise<ApiData> {
  const headers = await buildHeaders(env, trId, trCont);
  const url = new URL(`${baseUrl(env)}${apiPath}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const resp = await fetch(url.toString(), { headers });
  if (!resp.ok) {
    const body = await resp.text();
    throw Object.assign(new Error(`HTTP ${resp.status}`), { body });
  }
  const data = (await resp.json()) as ApiData;
  // tr_cont는 HTTP 응답 헤더에 있음
  data["_tr_cont"] = resp.headers.get("tr_cont") ?? "";
  return data;
}

async function apiPost(env: string, apiPath: string, trId: string, body: Record<string, string>): Promise<ApiData> {
  const headers = await buildHeaders(env, trId);
  const resp = await fetch(`${baseUrl(env)}${apiPath}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw Object.assign(new Error(`HTTP ${resp.status}`), { body: text });
  }
  return resp.json() as Promise<ApiData>;
}

export function checkResponse(data: ApiData, ctx: string): string {
  if (data["rt_cd"] !== "0") {
    return `Error [${data["msg_cd"] ?? "UNKNOWN"}]: ${data["msg1"] ?? "알 수 없는 오류"} (context: ${ctx})`;
  }
  return "";
}

function fmt(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

function getOutput(data: ApiData, key: string): ApiData {
  return (data[key] as ApiData) ?? {};
}

function text(result: string) {
  return { content: [{ type: "text" as const, text: result }] };
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({ name: "kis_mcp", version: "0.1.0" });

// ─── Tool 1: 국내주식 현재가 ──────────────────────────────────────────────────

server.tool(
  "kis_get_domestic_stock_price",
  "국내주식 현재가 시세를 조회합니다. 현재가·전일대비·등락률·거래량·시가총액·PER·PBR 등을 반환합니다.",
  {
    stock_code: z.string().describe("종목코드 6자리 (예: '005930' 삼성전자)"),
    market: z.string().default("J").describe("시장코드: J(KRX, 기본값), NX(NXT), UN(통합)"),
    env: z.string().default("real").describe("'real'(실전) 또는 'demo'(모의)"),
  },
  async ({ stock_code, market, env }) => {
    try {
      const data = await apiGet(env, "/uapi/domestic-stock/v1/quotations/inquire-price", "FHKST01010100", {
        FID_COND_MRKT_DIV_CODE: market,
        FID_INPUT_ISCD: stock_code,
      });
      const err = checkResponse(data, "국내주식 현재가");
      if (err) return text(err);
      const o = getOutput(data, "output");
      return text(fmt({
        종목코드: stock_code,
        현재가: o["stck_prpr"],
        전일대비: o["prdy_vrss"],
        등락률: o["prdy_ctrt"],
        거래량: o["acml_vol"],
        거래대금: o["acml_tr_pbmn"],
        시가: o["stck_oprc"],
        고가: o["stck_hgpr"],
        저가: o["stck_lwpr"],
        "52주_최고": o["w52_hgpr"],
        "52주_최저": o["w52_lwpr"],
        시가총액: o["hts_avls"],
        PER: o["per"],
        PBR: o["pbr"],
      }));
    } catch (e: unknown) {
      return text(`Error: ${(e as Error).message}`);
    }
  },
);

// ─── Tool 2: 국내주식 일/주/월별 시세 ────────────────────────────────────────

server.tool(
  "kis_get_domestic_stock_chart",
  "국내주식 일/주/월/년별 OHLCV 데이터를 날짜 범위로 조회합니다. 날짜 미지정 시 최근 데이터 반환.",
  {
    stock_code: z.string().describe("종목코드 6자리 (예: '005930')"),
    period: z.string().default("D").describe("기간구분: D(일봉), W(주봉), M(월봉), Y(년봉)"),
    start_date: z.string().default("").describe("시작일 YYYYMMDD (예: '20240101', 미입력 시 최초일)"),
    end_date: z.string().default("").describe("종료일 YYYYMMDD (예: '20241231', 미입력 시 오늘)"),
    adjusted: z.string().default("1").describe("수정주가: '1'(반영, 기본값), '0'(미반영)"),
    market: z.string().default("J").describe("시장코드: J(KRX, 기본값), NX, UN"),
    env: z.string().default("real").describe("'real' 또는 'demo'"),
  },
  async ({ stock_code, period, start_date, end_date, adjusted, market, env }) => {
    try {
      const data = await apiGet(
        env,
        "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
        "FHKST03010100",
        {
          FID_COND_MRKT_DIV_CODE: market,
          FID_INPUT_ISCD: stock_code,
          FID_INPUT_DATE_1: start_date,
          FID_INPUT_DATE_2: end_date,
          FID_PERIOD_DIV_CODE: period,
          FID_ORG_ADJ_PRC: adjusted,
        },
      );
      const err = checkResponse(data, "국내주식 기간별시세");
      if (err) return text(err);
      const rows = (data["output2"] as ApiData[]) ?? [];
      const result = rows.map((r) => ({
        날짜: r["stck_bsop_date"],
        종가: r["stck_clpr"],
        시가: r["stck_oprc"],
        고가: r["stck_hgpr"],
        저가: r["stck_lwpr"],
        거래량: r["acml_vol"],
        거래대금: r["acml_tr_pbmn"],
      }));
      return text(fmt({ 종목코드: stock_code, 기간: period, 데이터: result }));
    } catch (e: unknown) {
      return text(`Error: ${(e as Error).message}`);
    }
  },
);

// ─── Tool 3: 국내주식 잔고 ────────────────────────────────────────────────────

server.tool(
  "kis_get_domestic_balance",
  "국내주식 계좌의 보유 종목 잔고를 조회합니다. 수량·매입단가·평가금액·수익률 등을 반환합니다.",
  {
    env: z.string().default("real").describe("'real'(실전) 또는 'demo'(모의)"),
    account_no: z.string().optional().describe("계좌번호 앞 8자리 (미입력 시 환경변수 사용)"),
    account_prod: z.string().optional().describe("계좌상품코드 2자리 (미입력 시 환경변수 사용)"),
  },
  async ({ env, account_no, account_prod }) => {
    try {
      const { accountNo: envAcct, prodCd: envProd } = getCredentials(env);
      const cano = account_no || envAcct;
      const prod = account_prod || envProd;
      if (!cano) return text("Error: 계좌번호가 필요합니다. KIS_ACCOUNT_NO 환경변수 또는 account_no를 설정하세요.");

      const trId = env === "real" ? "TTTC8434R" : "VTTC8434R";
      const baseParams: Record<string, string> = {
        CANO: cano,
        ACNT_PRDT_CD: prod,
        AFHR_FLPR_YN: "N",
        OFL_YN: "",
        INQR_DVSN: "02",
        UNPR_DVSN: "01",
        FUND_STTL_ICLD_YN: "N",
        FNCG_AMT_AUTO_RDPT_YN: "N",
        PRCS_DVSN: "00",
        CTX_AREA_FK100: "",
        CTX_AREA_NK100: "",
      };

      const holdings: unknown[] = [];
      let summary: ApiData = {};
      let fk100 = "",
        nk100 = "";

      for (let i = 0; i < 10; i++) {
        const data = await apiGet(
          env,
          "/uapi/domestic-stock/v1/trading/inquire-balance",
          trId,
          { ...baseParams, CTX_AREA_FK100: fk100, CTX_AREA_NK100: nk100 },
        );
        const err = checkResponse(data, "국내주식 잔고");
        if (err) return text(err);

        for (const item of (data["output1"] as ApiData[]) ?? []) {
          holdings.push({
            종목코드: item["pdno"],
            종목명: item["prdt_name"],
            보유수량: item["hldg_qty"],
            매입단가: item["pchs_avg_pric"],
            현재가: item["prpr"],
            평가금액: item["evlu_amt"],
            손익금액: item["evlu_pfls_amt"],
            수익률: item["evlu_pfls_rt"],
          });
        }
        const out2 = (data["output2"] as ApiData[]) ?? [];
        if (out2.length) summary = out2[0];

        const trCont = data["_tr_cont"] as string;
        if (trCont !== "M" && trCont !== "F") break;
        fk100 = (data["ctx_area_fk100"] as string) ?? "";
        nk100 = (data["ctx_area_nk100"] as string) ?? "";
      }

      return text(fmt({
        계좌번호: cano,
        보유종목: holdings,
        총_매입금액: summary["pchs_amt_smtl_amt"],
        총_평가금액: summary["evlu_amt_smtl_amt"],
        총_손익금액: summary["evlu_pfls_smtl_amt"],
        예수금: summary["dnca_tot_amt"],
      }));
    } catch (e: unknown) {
      return text(`Error: ${(e as Error).message}`);
    }
  },
);

// ─── Tool 4: 계좌 자산 현황 ───────────────────────────────────────────────────

server.tool(
  "kis_get_account_assets",
  "투자계좌의 자산 현황을 조회합니다 (실전 전용). 자산 유형별 비중 및 총 평가금액을 반환합니다.",
  {
    account_no: z.string().optional().describe("계좌번호 앞 8자리 (미입력 시 환경변수 사용)"),
    account_prod: z.string().optional().describe("계좌상품코드 (미입력 시 환경변수 사용)"),
  },
  async ({ account_no, account_prod }) => {
    try {
      const { accountNo: envAcct, prodCd: envProd } = getCredentials("real");
      const cano = account_no || envAcct;
      const prod = account_prod || envProd;
      if (!cano) return text("Error: 계좌번호가 필요합니다. KIS_ACCOUNT_NO 환경변수 또는 account_no를 설정하세요.");

      const data = await apiGet("real", "/uapi/domestic-stock/v1/trading/inquire-account-balance", "CTRP6548R", {
        CANO: cano,
        ACNT_PRDT_CD: prod,
        INQR_DVSN_1: "",
        BSPR_BF_DT_APLY_YN: "",
      });
      const err = checkResponse(data, "계좌 자산 현황");
      if (err) return text(err);
      return text(fmt({ 자산_유형별: data["output1"], 계좌_요약: data["output2"] }));
    } catch (e: unknown) {
      return text(`Error: ${(e as Error).message}`);
    }
  },
);

// ─── Tool 5: 국내주식 현금 주문 ───────────────────────────────────────────────

server.tool(
  "kis_place_domestic_order",
  "국내주식 현금 매수/매도 주문을 제출합니다. env='real'이면 실제 자금이 사용됩니다.",
  {
    stock_code: z.string().describe("종목코드 6자리 (예: '005930')"),
    side: z.string().describe("'buy'(매수) 또는 'sell'(매도)"),
    quantity: z.string().describe("주문수량 (예: '10')"),
    price: z.string().describe("주문단가 (예: '75000', 시장가이면 '0')"),
    order_type: z.string().default("00").describe("주문구분: '00'(지정가, 기본값), '01'(시장가)"),
    exchange: z.string().default("KRX").describe("거래소: 'KRX'(기본값), 'NXT'"),
    env: z.string().default("demo").describe("'demo'(모의, 기본값) 또는 'real'(실전, 실제 자금 사용 주의!)"),
    account_no: z.string().optional().describe("계좌번호 앞 8자리"),
    account_prod: z.string().optional().describe("계좌상품코드 2자리"),
  },
  async ({ stock_code, side, quantity, price, order_type, exchange, env, account_no, account_prod }) => {
    try {
      const { accountNo: envAcct, prodCd: envProd } = getCredentials(env);
      const cano = account_no || envAcct;
      const prod = account_prod || envProd;
      if (!cano) return text("Error: 계좌번호가 필요합니다.");

      const trId =
        env === "real"
          ? side === "sell"
            ? "TTTC0011U"
            : "TTTC0012U"
          : side === "sell"
            ? "VTTC0011U"
            : "VTTC0012U";

      const data = await apiPost(env, "/uapi/domestic-stock/v1/trading/order-cash", trId, {
        CANO: cano,
        ACNT_PRDT_CD: prod,
        PDNO: stock_code,
        ORD_DVSN: order_type,
        ORD_QTY: quantity,
        ORD_UNPR: price,
        EXCG_ID_DVSN_CD: exchange,
        SLL_TYPE: side === "sell" ? "01" : "",
        CNDT_PRIC: "",
      });
      const err = checkResponse(data, "국내주식 주문");
      if (err) return text(err);
      const o = getOutput(data, "output");
      return text(fmt({
        결과: "주문 완료",
        환경: env,
        종목코드: stock_code,
        매수매도: side,
        주문수량: quantity,
        주문단가: price,
        주문번호: o["odno"],
        주문시각: o["ord_tmd"],
      }));
    } catch (e: unknown) {
      return text(`Error: ${(e as Error).message}`);
    }
  },
);

// ─── Tool 6: 국내주식 주문 정정/취소 ─────────────────────────────────────────

server.tool(
  "kis_revise_or_cancel_domestic_order",
  "미체결 국내주식 주문을 정정하거나 취소합니다. 이미 체결된 주문은 취소 불가합니다.",
  {
    action: z.string().describe("'revise'(정정) 또는 'cancel'(취소)"),
    org_order_no: z.string().describe("원주문번호"),
    org_order_orgno: z.string().describe("한국거래소전송주문조직번호 (원주문의 krx_fwdg_ord_orgno)"),
    order_type: z.string().describe("주문구분 (원주문과 동일, 예: '00')"),
    quantity: z.string().default("0").describe("주문수량 ('0'이면 잔량 전체)"),
    price: z.string().default("0").describe("정정 주문단가 (취소 시 '0')"),
    all_qty: z.string().default("Y").describe("잔량전부여부: 'Y'(전량, 기본값), 'N'(일부)"),
    exchange: z.string().default("KRX").describe("거래소: 'KRX'(기본값), 'NXT', 'SOR'"),
    env: z.string().default("demo").describe("'demo'(모의, 기본값) 또는 'real'(실전, 실제 자금 사용 주의!)"),
    account_no: z.string().optional().describe("계좌번호 앞 8자리"),
    account_prod: z.string().optional().describe("계좌상품코드"),
  },
  async ({ action, org_order_no, org_order_orgno, order_type, quantity, price, all_qty, exchange, env, account_no, account_prod }) => {
    try {
      const { accountNo: envAcct, prodCd: envProd } = getCredentials(env);
      const cano = account_no || envAcct;
      const prod = account_prod || envProd;
      if (!cano) return text("Error: 계좌번호가 필요합니다.");

      const trId = env === "real" ? "TTTC0013U" : "VTTC0013U";
      const rvseCd = action === "revise" ? "01" : "02";

      const data = await apiPost(env, "/uapi/domestic-stock/v1/trading/order-rvsecncl", trId, {
        CANO: cano,
        ACNT_PRDT_CD: prod,
        KRX_FWDG_ORD_ORGNO: org_order_orgno,
        ORGN_ODNO: org_order_no,
        ORD_DVSN: order_type,
        RVSE_CNCL_DVSN_CD: rvseCd,
        ORD_QTY: quantity,
        ORD_UNPR: price,
        QTY_ALL_ORD_YN: all_qty,
        EXCG_ID_DVSN_CD: exchange,
      });
      const err = checkResponse(data, "주문 정정/취소");
      if (err) return text(err);
      const o = getOutput(data, "output");
      return text(fmt({
        결과: `${action === "revise" ? "정정" : "취소"} 완료`,
        원주문번호: org_order_no,
        신규주문번호: o["odno"],
        주문시각: o["ord_tmd"],
      }));
    } catch (e: unknown) {
      return text(`Error: ${(e as Error).message}`);
    }
  },
);

// ─── Tool 7: 해외주식 현재가 ──────────────────────────────────────────────────

server.tool(
  "kis_get_overseas_stock_price",
  "해외주식 현재 체결가를 조회합니다. 미국·홍콩·중국·일본·베트남 주식 지원.",
  {
    symbol: z.string().describe("종목코드 (예: 'AAPL', 'TSLA')"),
    exchange: z
      .string()
      .describe("거래소코드: NAS(나스닥), NYSE(뉴욕), AMEX, SEHK(홍콩), SHAA(중국상해), SZAA(중국심천), TKSE(일본), HASE(베트남하노이), VNSE(베트남호치민)"),
    env: z.string().default("real").describe("'real' 또는 'demo'"),
  },
  async ({ symbol, exchange, env }) => {
    try {
      const data = await apiGet(env, "/uapi/overseas-price/v1/quotations/price", "HHDFS00000300", {
        AUTH: "",
        EXCD: exchange,
        SYMB: symbol,
      });
      const err = checkResponse(data, "해외주식 현재가");
      if (err) return text(err);
      const o = getOutput(data, "output");
      return text(fmt({
        종목코드: symbol,
        거래소: exchange,
        현재가: o["last"],
        전일종가: o["base"],
        전일대비: o["diff"],
        등락률: o["rate"],
        거래량: o["tvol"],
        거래대금: o["tamt"],
        전일거래량: o["pvol"],
        매수가능여부: o["ordy"],
      }));
    } catch (e: unknown) {
      return text(`Error: ${(e as Error).message}`);
    }
  },
);

// ─── Tool 8: 해외주식 일/주/월별 시세 ────────────────────────────────────────

server.tool(
  "kis_get_overseas_stock_chart",
  "해외주식 일/주/월별 OHLCV 데이터를 조회합니다.",
  {
    symbol: z.string().describe("종목코드 (예: 'AAPL')"),
    exchange: z.string().describe("거래소코드 (NAS/NYSE/AMEX/SEHK 등)"),
    period: z.string().default("0").describe("기간: '0'(일봉, 기본값), '1'(주봉), '2'(월봉)"),
    env: z.string().default("real").describe("'real' 또는 'demo'"),
  },
  async ({ symbol, exchange, period, env }) => {
    try {
      const data = await apiGet(env, "/uapi/overseas-price/v1/quotations/dailyprice", "HHDFS76240000", {
        AUTH: "",
        EXCD: exchange,
        SYMB: symbol,
        GUBN: period,
        BYMD: "",
        MODP: "0",
      });
      const err = checkResponse(data, "해외주식 일별시세");
      if (err) return text(err);
      const rows = (data["output2"] as ApiData[]) ?? [];
      const result = rows.map((r) => ({
        날짜: r["xymd"],
        종가: r["clos"],
        시가: r["open"],
        고가: r["high"],
        저가: r["low"],
        거래량: r["tvol"],
      }));
      return text(fmt({ 종목코드: symbol, 거래소: exchange, 기간: period, 데이터: result }));
    } catch (e: unknown) {
      return text(`Error: ${(e as Error).message}`);
    }
  },
);

// ─── Tool 9: 해외주식 잔고 ────────────────────────────────────────────────────

server.tool(
  "kis_get_overseas_balance",
  "해외주식 계좌의 보유 종목 잔고를 조회합니다.",
  {
    exchange: z
      .string()
      .default("NASD")
      .describe("거래소코드: NASD(미국전체)/SEHK/SHAA/SZAA/TKSE/HASE/VNSE"),
    currency: z
      .string()
      .default("USD")
      .describe("통화코드: USD(미국), HKD(홍콩), CNY(중국), JPY(일본), VND(베트남)"),
    env: z.string().default("real").describe("'real' 또는 'demo'"),
    account_no: z.string().optional().describe("계좌번호 앞 8자리"),
    account_prod: z.string().optional().describe("계좌상품코드"),
  },
  async ({ exchange, currency, env, account_no, account_prod }) => {
    try {
      const { accountNo: envAcct, prodCd: envProd } = getCredentials(env);
      const cano = account_no || envAcct;
      const prod = account_prod || envProd;
      if (!cano) return text("Error: 계좌번호가 필요합니다.");

      const trId = env === "real" ? "TTTS3012R" : "VTTS3012R";
      const holdings: unknown[] = [];
      let summary: ApiData = {};
      let fk200 = "",
        nk200 = "";

      for (let i = 0; i < 10; i++) {
        const data = await apiGet(env, "/uapi/overseas-stock/v1/trading/inquire-balance", trId, {
          CANO: cano,
          ACNT_PRDT_CD: prod,
          OVRS_EXCG_CD: exchange,
          TR_CRCY_CD: currency,
          CTX_AREA_FK200: fk200,
          CTX_AREA_NK200: nk200,
        });
        const err = checkResponse(data, "해외주식 잔고");
        if (err) return text(err);

        for (const item of (data["output1"] as ApiData[]) ?? []) {
          if (!item["ovrs_pdno"]) continue;
          holdings.push({
            종목코드: item["ovrs_pdno"],
            종목명: item["ovrs_item_name"],
            거래소: item["ovrs_excg_cd"],
            통화: item["tr_crcy_cd"],
            보유수량: item["ovrs_cblc_qty"],
            매입단가: item["pchs_avg_pric"],
            현재가: item["now_pric2"],
            평가금액: item["ovrs_stck_evlu_amt"],
            손익금액: item["frcr_evlu_pfls_amt"],
            수익률: item["evlu_pfls_rt"],
          });
        }

        const out2 = data["output2"] as ApiData;
        if (out2 && Object.keys(out2).length) summary = out2;

        const trCont = data["_tr_cont"] as string;
        if (trCont !== "M" && trCont !== "F") break;
        fk200 = (data["ctx_area_fk200"] as string) ?? "";
        nk200 = (data["ctx_area_nk200"] as string) ?? "";
      }

      return text(fmt({
        계좌번호: cano,
        거래소: exchange,
        통화: currency,
        보유종목: holdings,
        총_평가금액: summary["tot_evlu_pfls_amt"] ?? summary["ovrs_tot_pfls"],
      }));
    } catch (e: unknown) {
      return text(`Error: ${(e as Error).message}`);
    }
  },
);

// ─── Tool 10: 해외주식 주문 ───────────────────────────────────────────────────

const BUY_TR: Record<string, string> = {
  NASD: "TTTT1002U", NYSE: "TTTT1002U", AMEX: "TTTT1002U",
  SEHK: "TTTS1002U", SHAA: "TTTS0202U", SZAA: "TTTS0305U",
  TKSE: "TTTS0308U", HASE: "TTTS0311U", VNSE: "TTTS0311U",
};
const SELL_TR: Record<string, string> = {
  NASD: "TTTT1006U", NYSE: "TTTT1006U", AMEX: "TTTT1006U",
  SEHK: "TTTS1001U", SHAA: "TTTS1005U", SZAA: "TTTS0304U",
  TKSE: "TTTS0307U", HASE: "TTTS0310U", VNSE: "TTTS0310U",
};

server.tool(
  "kis_place_overseas_order",
  "해외주식 매수/매도 주문을 제출합니다. env='real'이면 실제 자금이 사용됩니다.",
  {
    symbol: z.string().describe("종목코드 (예: 'AAPL')"),
    exchange: z
      .string()
      .describe("거래소코드: NASD(나스닥), NYSE(뉴욕), AMEX, SEHK(홍콩), SHAA, SZAA, TKSE, HASE, VNSE"),
    side: z.string().describe("'buy'(매수) 또는 'sell'(매도)"),
    quantity: z.string().describe("주문수량"),
    price: z.string().describe("주문단가 (시장가이면 '0')"),
    order_type: z.string().default("00").describe("주문구분: '00'(지정가, 기본값)"),
    env: z.string().default("demo").describe("'demo'(모의, 기본값) 또는 'real'(실전, 실제 자금 사용 주의!)"),
    account_no: z.string().optional().describe("계좌번호 앞 8자리"),
    account_prod: z.string().optional().describe("계좌상품코드"),
  },
  async ({ symbol, exchange, side, quantity, price, order_type, env, account_no, account_prod }) => {
    try {
      const { accountNo: envAcct, prodCd: envProd } = getCredentials(env);
      const cano = account_no || envAcct;
      const prod = account_prod || envProd;
      if (!cano) return text("Error: 계좌번호가 필요합니다.");

      const trMap = side === "buy" ? BUY_TR : SELL_TR;
      let trId = trMap[exchange];
      if (!trId) return text(`Error: 지원하지 않는 거래소: ${exchange}`);
      if (env === "demo") trId = "V" + trId.slice(1);

      const data = await apiPost(env, "/uapi/overseas-stock/v1/trading/order", trId, {
        CANO: cano,
        ACNT_PRDT_CD: prod,
        OVRS_EXCG_CD: exchange,
        PDNO: symbol,
        ORD_QTY: quantity,
        OVRS_ORD_UNPR: price,
        CTAC_TLNO: "",
        MGCO_APTM_ODNO: "",
        SLL_TYPE: side === "sell" ? "00" : "",
        ORD_SVR_DVSN_CD: "0",
        ORD_DVSN: order_type,
      });
      const err = checkResponse(data, "해외주식 주문");
      if (err) return text(err);
      const o = getOutput(data, "output");
      return text(fmt({
        결과: "주문 완료",
        환경: env,
        종목코드: symbol,
        거래소: exchange,
        매수매도: side,
        주문수량: quantity,
        주문단가: price,
        주문번호: o["odno"],
        주문시각: o["ord_tmd"],
      }));
    } catch (e: unknown) {
      return text(`Error: ${(e as Error).message}`);
    }
  },
);

// ─── Tool 11: 종목 검색 ───────────────────────────────────────────────────────

server.tool(
  "kis_search_stock",
  "종목코드 또는 종목명으로 종목을 검색합니다. 국내(KOSPI/KOSDAQ)·해외(미국·홍콩·일본 등) 전 종목 지원.\n마스터 데이터는 하루 1회 자동 갱신됩니다 (첫 호출 시 다운로드, 수 초 소요).",
  {
    query: z.string().describe("종목코드 또는 종목명 (예: '삼성전자', '005930', 'AAPL', '애플')"),
    markets: z
      .array(z.string())
      .optional()
      .describe("검색 대상 market 목록 (기본값: 전체). KOSPI, KOSDAQ, NAS, NYS, AMS, HKS, TSE, SHS, SZS, HNX, HSX"),
    limit: z.number().int().min(1).max(50).default(10).describe("최대 반환 수 (기본값: 10)"),
  },
  async ({ query, markets, limit }) => {
    const targetMarkets = markets ?? master.ALL_MARKETS;
    const refreshStatus = await master.ensureFresh(targetMarkets);
    const staleFailed = Object.entries(refreshStatus)
      .filter(([, v]) => v.startsWith("실패"))
      .map(([k]) => k);
    const results = master.search(query, targetMarkets, limit);

    const response: Record<string, unknown> = { 검색어: query, 결과수: results.length, 결과: results };
    if (staleFailed.length) {
      response["경고"] = `다음 시장 데이터 갱신 실패 (검색 결과 제한될 수 있음): ${staleFailed}`;
    }
    return text(fmt(response));
  },
);

// ─── Tool 12: 마스터 DB 현황 ──────────────────────────────────────────────────

server.tool(
  "kis_master_status",
  "로컬 종목 마스터 DB의 시장별 종목 수와 마지막 갱신일을 조회합니다.",
  {},
  async () => {
    const stats = master.getDbStats();
    return text(fmt({ 마스터_DB: stats, DB_경로: master.DB_PATH }));
  },
);

// ─── 진입점 ───────────────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
