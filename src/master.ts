/**
 * KIS 종목 마스터 파일 관리
 * 마스터 파일을 하루 1회 다운로드해 ~/.kis_mcp/master.db 에 캐시합니다.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { DatabaseSync } from "node:sqlite";
import AdmZip from "adm-zip";
import iconv from "iconv-lite";
import { fetch, Agent } from "undici";

export const DB_PATH = path.join(os.homedir(), ".kis_mcp", "master.db");

const DOMESTIC: Record<string, [string, number]> = {
  KOSDAQ: ["https://new.real.download.dws.co.kr/common/master/kosdaq_code.mst.zip", 222],
  KOSPI: ["https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip", 228],
};

const OVERSEAS: Record<string, string> = {
  NAS: "https://new.real.download.dws.co.kr/common/master/nasmst.cod.zip",
  NYS: "https://new.real.download.dws.co.kr/common/master/nysmst.cod.zip",
  AMS: "https://new.real.download.dws.co.kr/common/master/amsmst.cod.zip",
  HKS: "https://new.real.download.dws.co.kr/common/master/hksmst.cod.zip",
  TSE: "https://new.real.download.dws.co.kr/common/master/tsemst.cod.zip",
  SHS: "https://new.real.download.dws.co.kr/common/master/shsmst.cod.zip",
  SZS: "https://new.real.download.dws.co.kr/common/master/szsmst.cod.zip",
  HNX: "https://new.real.download.dws.co.kr/common/master/hnxmst.cod.zip",
  HSX: "https://new.real.download.dws.co.kr/common/master/hsxmst.cod.zip",
};

export const ALL_MARKETS = [...Object.keys(DOMESTIC), ...Object.keys(OVERSEAS)];

type Row = [string, string, string, string | null];

function openDb(): DatabaseSync {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS stocks (
      code     TEXT NOT NULL,
      name     TEXT NOT NULL,
      market   TEXT NOT NULL,
      exchange TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_stocks_code   ON stocks(code);
    CREATE INDEX IF NOT EXISTS idx_stocks_name   ON stocks(name);
    CREATE INDEX IF NOT EXISTS idx_stocks_market ON stocks(market);
    CREATE TABLE IF NOT EXISTS meta (
      market       TEXT PRIMARY KEY,
      updated_date TEXT NOT NULL
    );
  `);
  return db;
}

function isStale(market: string): boolean {
  try {
    const db = openDb();
    const row = db
      .prepare("SELECT updated_date FROM meta WHERE market = ?")
      .get(market) as { updated_date: string } | undefined;
    db.close();
    return !row || row.updated_date !== new Date().toISOString().slice(0, 10);
  } catch {
    return true;
  }
}

// 마스터 파일 서버는 자체 서명 인증서 사용 → SSL 검증 비활성화
const _agent = new Agent({ connect: { rejectUnauthorized: false } });

async function downloadZip(url: string): Promise<Buffer> {
  const resp = await fetch(url, { dispatcher: _agent });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const zip = new AdmZip(buf);
  const entries = zip.getEntries();
  if (entries.length === 0) throw new Error("ZIP is empty");
  return entries[0].getData();
}

function decode(buf: Buffer): string {
  try {
    return iconv.decode(buf, "cp949");
  } catch {
    return buf.toString("utf8");
  }
}

function parseDomestic(raw: Buffer, market: string, offset: number): Row[] {
  const rows: Row[] = [];
  for (const line of decode(raw).split("\n")) {
    if (line.length <= 21 + offset) continue;
    const code = line.slice(0, 9).trimEnd();
    const name = line.slice(21, line.length - offset).trim().replace(/\s+/g, "");
    if (code && name) rows.push([code, name, market, null]);
  }
  return rows;
}

function parseOverseas(raw: Buffer, exchange: string): Row[] {
  const rows: Row[] = [];
  for (const line of decode(raw).split("\n")) {
    const cols = line.split("\t");
    if (cols.length < 7) continue;
    const code = cols[4].trim();
    const name = cols[6].trim().replace(/\s+/g, "");
    if (code && name) rows.push([code, name, exchange, exchange]);
  }
  return rows;
}

export async function refresh(market: string): Promise<number> {
  let rows: Row[];
  if (market in DOMESTIC) {
    const [url, offset] = DOMESTIC[market];
    rows = parseDomestic(await downloadZip(url), market, offset);
  } else if (market in OVERSEAS) {
    rows = parseOverseas(await downloadZip(OVERSEAS[market]), market);
  } else {
    throw new Error(`알 수 없는 market: ${market}`);
  }

  const db = openDb();
  db.prepare("DELETE FROM stocks WHERE market = ? OR (market = 'OVERSEAS' AND exchange = ?)").run(market, market);
  const ins = db.prepare("INSERT INTO stocks(code, name, market, exchange) VALUES(?, ?, ?, ?)");
  db.exec("BEGIN");
  for (const r of rows) ins.run(...r);
  db.exec("COMMIT");
  db.prepare("INSERT OR REPLACE INTO meta(market, updated_date) VALUES(?, ?)").run(
    market,
    new Date().toISOString().slice(0, 10),
  );
  db.close();
  return rows.length;
}

export async function ensureFresh(markets: string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const m of markets) {
    if (isStale(m)) {
      try {
        result[m] = `갱신 (${await refresh(m)}종목)`;
      } catch (e) {
        result[m] = `실패: ${e}`;
      }
    } else {
      result[m] = "최신";
    }
  }
  return result;
}

export interface StockResult {
  code: string;
  name: string;
  market: string;
  exchange: string | null;
}

export function search(query: string, markets: string[] | null = null, limit = 10): StockResult[] {
  const q = query.replace(/\s+/g, "");
  const db = openDb();

  const mClause = markets?.length ? ` AND market IN (${markets.map(() => "?").join(",")})` : "";
  const mParams: string[] = markets ?? [];
  const base = `SELECT code, name, market, exchange FROM stocks WHERE {cond}${mClause} LIMIT ?`;

  const candidates: [string, string][] = [
    ["code = ?", q],
    ["name = ?", q],
    ["name LIKE ?", `${q}%`],
    ["name LIKE ?", `%${q}%`],
  ];

  let rows: StockResult[] = [];
  for (const [cond, val] of candidates) {
    rows = db.prepare(base.replace("{cond}", cond)).all(val, ...mParams, limit) as unknown as StockResult[];
    if (rows.length) break;
  }
  db.close();
  return rows;
}

export function getDbStats(): Record<string, { count: number; updated: string }> {
  const db = openDb();
  const counts = db
    .prepare("SELECT market, COUNT(*) as cnt FROM stocks GROUP BY market")
    .all() as { market: string; cnt: number }[];
  const meta = db
    .prepare("SELECT market, updated_date FROM meta")
    .all() as { market: string; updated_date: string }[];
  db.close();

  const countMap = Object.fromEntries(counts.map((r) => [r.market, r.cnt]));
  const dateMap = Object.fromEntries(meta.map((r) => [r.market, r.updated_date]));

  return Object.fromEntries(
    ALL_MARKETS.map((m) => [m, { count: countMap[m] ?? 0, updated: dateMap[m] ?? "없음" }]),
  );
}
