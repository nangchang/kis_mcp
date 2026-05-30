# 한국투자증권 KIS MCP Server

한국투자증권 Open API를 Claude에서 직접 사용할 수 있는 MCP 서버입니다.

## 사전 준비

1. [KIS Developers](https://apiportal.koreainvestment.com) 에서 앱키/앱시크리트 발급
2. Node.js 22+ 및 npm 설치

## 환경변수 설정

```bash
# 실전투자 (필수)
export KIS_APP_KEY="your_app_key"
export KIS_APP_SECRET="your_app_secret"
export KIS_ACCOUNT_NO="12345678"     # 계좌번호 앞 8자리
export KIS_ACCOUNT_PROD="01"         # 계좌상품코드 (기본값: 01)

# 모의투자 (선택)
export KIS_PAPER_APP_KEY="your_paper_app_key"
export KIS_PAPER_APP_SECRET="your_paper_app_secret"
export KIS_PAPER_ACCOUNT_NO="12345678"
```

## 빌드 및 실행

```bash
npm install
npm run build
```

## Claude Code 설정 (.mcp.json)

프로젝트 루트 또는 `~/.claude/` 에 추가:

```json
{
  "mcpServers": {
    "kis": {
      "command": "node",
      "args": ["/path/to/koreainvestment-mcp/dist/index.js"],
      "env": {
        "KIS_APP_KEY": "your_app_key",
        "KIS_APP_SECRET": "your_app_secret",
        "KIS_ACCOUNT_NO": "12345678",
        "KIS_PAPER_APP_KEY": "your_paper_app_key",
        "KIS_PAPER_APP_SECRET": "your_paper_app_secret",
        "KIS_PAPER_ACCOUNT_NO": "12345678"
      }
    }
  }
}
```

개발 중에는 `tsx`로 직접 실행 가능:

```json
{
  "mcpServers": {
    "kis": {
      "command": "npx",
      "args": ["tsx", "/path/to/koreainvestment-mcp/src/index.ts"],
      "env": { "...": "..." }
    }
  }
}
```

## 제공 도구 (12개)

| 도구 | 설명 | 읽기전용 |
|------|------|:---:|
| `kis_get_domestic_stock_price` | 국내주식 현재가 조회 | ✅ |
| `kis_get_domestic_stock_chart` | 국내주식 일/주/월별 시세 | ✅ |
| `kis_get_domestic_balance` | 국내주식 잔고 조회 | ✅ |
| `kis_get_account_assets` | 투자계좌 자산 현황 (실전 전용) | ✅ |
| `kis_place_domestic_order` | 국내주식 현금 주문 | ❌ |
| `kis_revise_or_cancel_domestic_order` | 국내주식 주문 정정/취소 | ❌ |
| `kis_get_overseas_stock_price` | 해외주식 현재가 조회 | ✅ |
| `kis_get_overseas_stock_chart` | 해외주식 일/주/월별 시세 | ✅ |
| `kis_get_overseas_balance` | 해외주식 잔고 조회 | ✅ |
| `kis_place_overseas_order` | 해외주식 주문 | ❌ |
| `kis_search_stock` | 종목코드·종목명 검색 | ✅ |
| `kis_master_status` | 종목 마스터 DB 현황 | ✅ |

## 주의사항

- `env="real"` 주문 도구는 **실제 자금**이 사용됩니다. 테스트는 반드시 `env="demo"`를 사용하세요.
- 주문 도구의 기본값은 `env="demo"`(모의투자)로 설정되어 있습니다.
- 실전투자와 모의투자의 앱키/계좌번호는 별개입니다.
- 토큰은 프로세스 메모리에 캐시되며 만료 5분 전에 자동 재발급됩니다.
- 종목 마스터 데이터는 `~/.kis_mcp/master.db`에 저장되며 하루 1회 자동 갱신됩니다.
