/**
 * KIS 모의투자(paper trading) 통합 테스트
 *
 * 실행 전 환경변수 설정 필요:
 *   KIS_PAPER_APP_KEY      - 모의투자 앱키
 *   KIS_PAPER_APP_SECRET   - 모의투자 앱시크리트
 *   KIS_PAPER_ACCOUNT_NO   - 모의투자 계좌번호 앞 8자리  (잔고 테스트에 필요)
 *
 * 실행:
 *   npm run test:integration
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { getAccessToken, apiGet } from "./index.js";

type ApiData = Record<string, unknown>;

// ─── Skip 조건 ────────────────────────────────────────────────────────────────

const CREDS_SKIP: string | false =
  !process.env["KIS_PAPER_APP_KEY"] || !process.env["KIS_PAPER_APP_SECRET"]
    ? "KIS_PAPER_APP_KEY / KIS_PAPER_APP_SECRET 미설정 — 모의투자 자격증명 필요"
    : false;

const ACCT_SKIP: string | false =
  CREDS_SKIP ||
  (!process.env["KIS_PAPER_ACCOUNT_NO"]
    ? "KIS_PAPER_ACCOUNT_NO 미설정"
    : false);

const T = { timeout: 15_000 }; // 15초 타임아웃

// ─── 인증 ─────────────────────────────────────────────────────────────────────

describe("인증", () => {
  test("토큰 발급 및 캐시 재사용", { skip: CREDS_SKIP, ...T }, async () => {
    const t1 = await getAccessToken("demo");
    const t2 = await getAccessToken("demo"); // 캐시 반환이어야 함
    assert.ok(t1.length > 10, "토큰이 너무 짧음");
    assert.strictEqual(t1, t2, "두 번째 호출에서 캐시된 토큰을 반환해야 함");
  });
});

// ─── 국내주식 ─────────────────────────────────────────────────────────────────

describe("국내주식", () => {
  test("현재가 조회 — 삼성전자(005930)", { skip: CREDS_SKIP, ...T }, async () => {
    const data = await apiGet(
      "demo",
      "/uapi/domestic-stock/v1/quotations/inquire-price",
      "FHKST01010100",
      { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: "005930" },
    );
    assert.strictEqual(data["rt_cd"], "0", `API 오류: ${data["msg1"]}`);
    const out = data["output"] as ApiData;
    assert.ok(out["stck_prpr"], "현재가(stck_prpr) 필드 없음");
    assert.ok(out["acml_vol"], "거래량(acml_vol) 필드 없음");
    assert.ok(out["prdy_ctrt"], "등락률(prdy_ctrt) 필드 없음");
  });

  test("일별 시세 조회 — 삼성전자", { skip: CREDS_SKIP, ...T }, async () => {
    const data = await apiGet(
      "demo",
      "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
      "FHKST03010100",
      {
        FID_COND_MRKT_DIV_CODE: "J",
        FID_INPUT_ISCD: "005930",
        FID_INPUT_DATE_1: "",
        FID_INPUT_DATE_2: "",
        FID_PERIOD_DIV_CODE: "D",
        FID_ORG_ADJ_PRC: "1",
      },
    );
    assert.strictEqual(data["rt_cd"], "0", `API 오류: ${data["msg1"]}`);
    const rows = data["output2"] as ApiData[];
    assert.ok(Array.isArray(rows) && rows.length > 0, "output2 배열이 비어 있음");
    // OHLCV 필드 존재 확인
    const first = rows[0];
    assert.ok(first["stck_bsop_date"], "날짜(stck_bsop_date) 필드 없음");
    assert.ok(first["stck_clpr"], "종가(stck_clpr) 필드 없음");
    assert.ok(first["acml_vol"], "거래량(acml_vol) 필드 없음");
  });

  test("잔고 조회", { skip: ACCT_SKIP, ...T }, async () => {
    const cano = process.env["KIS_PAPER_ACCOUNT_NO"]!;
    const prod = process.env["KIS_ACCOUNT_PROD"] ?? "01";
    const data = await apiGet(
      "demo",
      "/uapi/domestic-stock/v1/trading/inquire-balance",
      "VTTC8434R",
      {
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
      },
    );
    assert.strictEqual(data["rt_cd"], "0", `API 오류: ${data["msg1"]}`);
    assert.ok(Array.isArray(data["output1"]), "output1 배열 없음");
    assert.ok(Array.isArray(data["output2"]), "output2 배열 없음");
  });
});

// ─── 해외주식 ─────────────────────────────────────────────────────────────────

describe("해외주식", () => {
  test("현재가 조회 — AAPL @ NAS", { skip: CREDS_SKIP, ...T }, async () => {
    const data = await apiGet(
      "demo",
      "/uapi/overseas-price/v1/quotations/price",
      "HHDFS00000300",
      { AUTH: "", EXCD: "NAS", SYMB: "AAPL" },
    );
    assert.strictEqual(data["rt_cd"], "0", `API 오류: ${data["msg1"]}`);
    const out = data["output"] as ApiData;
    assert.ok(out["last"], "현재가(last) 필드 없음");
    assert.ok(out["base"], "전일종가(base) 필드 없음");
    assert.ok(out["tvol"] !== undefined, "거래량(tvol) 필드 없음");
  });

  test("일별 시세 조회 — AAPL", { skip: CREDS_SKIP, ...T }, async () => {
    const data = await apiGet(
      "demo",
      "/uapi/overseas-price/v1/quotations/dailyprice",
      "HHDFS76240000",
      { AUTH: "", EXCD: "NAS", SYMB: "AAPL", GUBN: "0", BYMD: "", MODP: "0" },
    );
    assert.strictEqual(data["rt_cd"], "0", `API 오류: ${data["msg1"]}`);
    const rows = data["output2"] as ApiData[];
    assert.ok(Array.isArray(rows) && rows.length > 0, "output2 배열이 비어 있음");
    const first = rows[0];
    assert.ok(first["xymd"], "날짜(xymd) 필드 없음");
    assert.ok(first["clos"], "종가(clos) 필드 없음");
    assert.ok(first["tvol"] !== undefined, "거래량(tvol) 필드 없음");
  });

  test("잔고 조회 — 미국(NASD/USD)", { skip: ACCT_SKIP, ...T }, async () => {
    const cano = process.env["KIS_PAPER_ACCOUNT_NO"]!;
    const prod = process.env["KIS_ACCOUNT_PROD"] ?? "01";
    const data = await apiGet(
      "demo",
      "/uapi/overseas-stock/v1/trading/inquire-balance",
      "VTTS3012R",
      {
        CANO: cano,
        ACNT_PRDT_CD: prod,
        OVRS_EXCG_CD: "NASD",
        TR_CRCY_CD: "USD",
        CTX_AREA_FK200: "",
        CTX_AREA_NK200: "",
      },
    );
    assert.strictEqual(data["rt_cd"], "0", `API 오류: ${data["msg1"]}`);
    assert.ok(Array.isArray(data["output1"]), "output1 배열 없음");
  });
});
