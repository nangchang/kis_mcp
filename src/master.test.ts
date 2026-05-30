import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import iconv from "iconv-lite";
import { parseDomestic, parseOverseas, search, getDbStats, ALL_MARKETS } from "./master.js";

// ─── 임시 DB 셋업 ─────────────────────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kis_mcp_test_"));
const testDbPath = path.join(tmpDir, "test.db");
// openDb() 가 호출될 때 이 경로를 읽음
process.env["KIS_MCP_DB_PATH"] = testDbPath;

type Row = [string, string, string, string | null];

function seedDb(records: Row[], updatedMarkets: Record<string, string> = {}) {
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  const db = new DatabaseSync(testDbPath);
  db.exec(`
    CREATE TABLE stocks (code TEXT NOT NULL, name TEXT NOT NULL, market TEXT NOT NULL, exchange TEXT);
    CREATE INDEX idx_stocks_code   ON stocks(code);
    CREATE INDEX idx_stocks_name   ON stocks(name);
    CREATE INDEX idx_stocks_market ON stocks(market);
    CREATE TABLE meta (market TEXT PRIMARY KEY, updated_date TEXT NOT NULL);
  `);
  const ins = db.prepare("INSERT INTO stocks VALUES (?, ?, ?, ?)");
  for (const r of records) ins.run(...r);
  for (const [mkt, dt] of Object.entries(updatedMarkets)) {
    db.prepare("INSERT OR REPLACE INTO meta VALUES (?, ?)").run(mkt, dt);
  }
  db.close();
}

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

// ─── parseDomestic ────────────────────────────────────────────────────────────

describe("parseDomestic", () => {
  // 레이아웃: [0:9] 종목코드, [9:21] 표준코드, [21:len-offset] 종목명, suffix(offset bytes)
  test("KOSPI 단일 종목 파싱 (offset=228)", () => {
    const line = "005930   " + "KR7005930003" + "삼성전자" + "X".repeat(228);
    const raw = iconv.encode(line, "cp949");
    const records = parseDomestic(raw, "KOSPI", 228);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0], ["005930", "삼성전자", "KOSPI", null]);
  });

  test("KOSDAQ 단일 종목 파싱 (offset=222)", () => {
    const line = "035720   " + "KR7035720002" + "카카오" + "Y".repeat(222);
    const raw = iconv.encode(line, "cp949");
    const records = parseDomestic(raw, "KOSDAQ", 222);
    assert.equal(records.length, 1);
    assert.equal(records[0][0], "035720");
    assert.equal(records[0][1], "카카오");
    assert.equal(records[0][2], "KOSDAQ");
  });

  test("종목명 내 공백 제거", () => {
    const line = "000660   " + "KR7000660001" + "SK 하이닉스" + "Z".repeat(228);
    const raw = iconv.encode(line, "cp949");
    const [rec] = parseDomestic(raw, "KOSPI", 228);
    assert.equal(rec[1], "SK하이닉스");
  });

  test("너무 짧은 라인은 건너뜀", () => {
    const line = "005930   " + "KR7005930003" + "짧음"; // 21 + 4 = 25, <= 21+228
    const raw = iconv.encode(line, "cp949");
    const records = parseDomestic(raw, "KOSPI", 228);
    assert.equal(records.length, 0);
  });

  test("빈 코드/이름 라인은 건너뜀", () => {
    // 코드가 공백뿐인 경우
    const line = "         " + "KR7005930003" + "삼성전자" + "X".repeat(228);
    const raw = iconv.encode(line, "cp949");
    const records = parseDomestic(raw, "KOSPI", 228);
    assert.equal(records.length, 0);
  });

  test("복수 라인 파싱", () => {
    const make = (code: string, name: string) =>
      code.padEnd(9) + "KR0000000000" + name + "X".repeat(228);
    const raw = iconv.encode(
      [make("000001", "종목A"), make("000002", "종목B")].join("\n"),
      "cp949",
    );
    const records = parseDomestic(raw, "KOSPI", 228);
    assert.equal(records.length, 2);
    assert.equal(records[0][0], "000001");
    assert.equal(records[1][0], "000002");
  });
});

// ─── parseOverseas ────────────────────────────────────────────────────────────

describe("parseOverseas", () => {
  // TSV: col[4]=심볼, col[6]=한국명
  function makeLine(cols: string[]) {
    return cols.join("\t");
  }

  // 해외 마스터 파일도 CP949 인코딩 (KIS 파일 전체 공통)
  test("기본 TSV 파싱", () => {
    const line = makeLine(["a", "b", "c", "d", "AAPL", "f", "애플"]);
    const raw = iconv.encode(line, "cp949");
    const records = parseOverseas(raw, "NAS");
    assert.equal(records.length, 1);
    assert.deepEqual(records[0], ["AAPL", "애플", "NAS", "NAS"]);
  });

  test("종목명 내 공백 제거", () => {
    const line = makeLine(["a", "b", "c", "d", "TSLA", "f", "테슬라 모터스"]);
    const raw = iconv.encode(line, "cp949");
    const [rec] = parseOverseas(raw, "NAS");
    assert.equal(rec[1], "테슬라모터스");
  });

  test("컬럼 수 부족한 라인은 건너뜀", () => {
    const line = "a\tb\tc\td\tAAPL\tf"; // 6 cols, need >= 7
    const raw = iconv.encode(line, "cp949");
    const records = parseOverseas(raw, "NAS");
    assert.equal(records.length, 0);
  });

  test("exchange 코드가 market 과 exchange 양쪽에 저장됨", () => {
    const line = makeLine(["a", "b", "c", "d", "GOOGL", "f", "구글"]);
    const raw = iconv.encode(line, "cp949");
    const [rec] = parseOverseas(raw, "NYS");
    assert.equal(rec[2], "NYS"); // market
    assert.equal(rec[3], "NYS"); // exchange
  });
});

// ─── search ───────────────────────────────────────────────────────────────────

describe("search", () => {
  before(() => {
    seedDb(
      [
        ["005930", "삼성전자", "KOSPI", null],
        ["035720", "카카오", "KOSDAQ", null],
        ["000660", "SK하이닉스", "KOSPI", null],
        ["AAPL", "애플", "NAS", "NAS"],
        ["TSLA", "테슬라모터스", "NAS", "NAS"],
        ["005380", "현대자동차", "KOSPI", null],
      ],
      { KOSPI: new Date().toISOString().slice(0, 10) },
    );
  });

  test("종목코드 정확 일치", () => {
    const r = search("005930");
    assert.equal(r.length, 1);
    assert.equal(r[0].name, "삼성전자");
  });

  test("종목명 정확 일치", () => {
    const r = search("카카오");
    assert.equal(r[0].code, "035720");
  });

  test("종목명 앞글자(prefix) 매치", () => {
    const r = search("삼성");
    assert.ok(r.some((x) => x.code === "005930"));
  });

  test("종목명 포함(contains) 매치", () => {
    const r = search("하이닉");
    assert.ok(r.some((x) => x.code === "000660"));
  });

  test("존재하지 않는 종목 → 빈 배열", () => {
    const r = search("없는종목XYZXYZ");
    assert.equal(r.length, 0);
  });

  test("markets 필터 — NAS 만 조회", () => {
    const r = search("애플", ["NAS"]);
    assert.equal(r.length, 1);
    assert.equal(r[0].code, "AAPL");
  });

  test("markets 필터 — KOSPI 에서 AAPL 은 나오지 않음", () => {
    const r = search("AAPL", ["KOSPI"]);
    assert.equal(r.length, 0);
  });

  test("limit 가 결과 수를 제한함", () => {
    // "자" 포함 종목이 여러 개일 수 있지만 limit=1
    const r = search("현대", null, 1);
    assert.equal(r.length, 1);
  });

  test("markets=null 이면 전체 시장 검색", () => {
    const r = search("테슬라모터스", null);
    assert.ok(r.some((x) => x.market === "NAS"));
  });
});

// ─── getDbStats ───────────────────────────────────────────────────────────────

describe("getDbStats", () => {
  before(() => {
    const today = new Date().toISOString().slice(0, 10);
    seedDb(
      [
        ["005930", "삼성전자", "KOSPI", null],
        ["035720", "카카오", "KOSDAQ", null],
        ["AAPL", "애플", "NAS", "NAS"],
      ],
      { KOSPI: today, KOSDAQ: today, NAS: today },
    );
  });

  test("ALL_MARKETS 키를 모두 포함", () => {
    const stats = getDbStats();
    for (const m of ALL_MARKETS) {
      assert.ok(m in stats, `${m} 키 없음`);
    }
  });

  test("시장별 종목 수 정확", () => {
    const stats = getDbStats();
    assert.equal(stats["KOSPI"].count, 1);
    assert.equal(stats["KOSDAQ"].count, 1);
    assert.equal(stats["NAS"].count, 1);
  });

  test("갱신일 문자열 형식 YYYY-MM-DD", () => {
    const stats = getDbStats();
    assert.match(stats["KOSPI"].updated, /^\d{4}-\d{2}-\d{2}$/);
  });

  test("데이터 없는 시장은 count=0, updated='없음'", () => {
    const stats = getDbStats();
    assert.equal(stats["TSE"].count, 0);
    assert.equal(stats["TSE"].updated, "없음");
  });
});
