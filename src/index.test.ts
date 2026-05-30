import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { checkResponse, getCredentials } from "./index.js";

// ─── checkResponse ────────────────────────────────────────────────────────────

describe("checkResponse", () => {
  test("rt_cd='0' 이면 빈 문자열 반환", () => {
    const result = checkResponse({ rt_cd: "0" }, "테스트");
    assert.equal(result, "");
  });

  test("rt_cd 가 '0' 아니면 오류 메시지 반환", () => {
    const result = checkResponse(
      { rt_cd: "1", msg_cd: "E001", msg1: "잘못된 요청" },
      "국내주식 현재가",
    );
    assert.ok(result.startsWith("Error"));
    assert.ok(result.includes("E001"));
    assert.ok(result.includes("잘못된 요청"));
    assert.ok(result.includes("국내주식 현재가"));
  });

  test("msg_cd 없으면 UNKNOWN 으로 폴백", () => {
    const result = checkResponse({ rt_cd: "2" }, "테스트");
    assert.ok(result.includes("UNKNOWN"));
  });

  test("msg1 없으면 '알 수 없는 오류' 로 폴백", () => {
    const result = checkResponse({ rt_cd: "1", msg_cd: "E999" }, "테스트");
    assert.ok(result.includes("알 수 없는 오류"));
  });
});

// ─── getCredentials ───────────────────────────────────────────────────────────

describe("getCredentials", () => {
  const saved: Record<string, string | undefined> = {};

  function setEnvs(vars: Record<string, string>) {
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  }

  function restoreEnvs() {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const k of Object.keys(saved)) delete saved[k];
  }

  afterEach(restoreEnvs);

  test("실전(real) 환경변수 정상 반환", () => {
    setEnvs({
      KIS_APP_KEY: "test-key",
      KIS_APP_SECRET: "test-secret",
      KIS_ACCOUNT_NO: "12345678",
      KIS_ACCOUNT_PROD: "01",
    });
    const cred = getCredentials("real");
    assert.equal(cred.appKey, "test-key");
    assert.equal(cred.appSecret, "test-secret");
    assert.equal(cred.accountNo, "12345678");
    assert.equal(cred.prodCd, "01");
  });

  test("모의(demo) 환경변수 정상 반환", () => {
    setEnvs({
      KIS_PAPER_APP_KEY: "paper-key",
      KIS_PAPER_APP_SECRET: "paper-secret",
      KIS_PAPER_ACCOUNT_NO: "87654321",
    });
    const cred = getCredentials("demo");
    assert.equal(cred.appKey, "paper-key");
    assert.equal(cred.appSecret, "paper-secret");
    assert.equal(cred.accountNo, "87654321");
  });

  test("KIS_ACCOUNT_PROD 미설정 시 기본값 '01'", () => {
    setEnvs({ KIS_APP_KEY: "k", KIS_APP_SECRET: "s" });
    delete process.env["KIS_ACCOUNT_PROD"];
    const cred = getCredentials("real");
    assert.equal(cred.prodCd, "01");
  });

  test("앱키 없으면 오류 발생", () => {
    delete process.env["KIS_APP_KEY"];
    delete process.env["KIS_APP_SECRET"];
    assert.throws(() => getCredentials("real"), /KIS_APP_KEY/);
  });

  test("모의 앱키 없으면 오류 메시지에 PAPER_ 포함", () => {
    delete process.env["KIS_PAPER_APP_KEY"];
    delete process.env["KIS_PAPER_APP_SECRET"];
    assert.throws(() => getCredentials("demo"), /KIS_PAPER_APP_KEY/);
  });
});
