# 🇰🇷 Korean Land MCP (토지 공간정보 MCP) — v2.1

**V-World API 기반 토지·도시계획 공간정보 MCP 서버**
국토교통부 V-World Open API를 백엔드로 사용해, 토지이음(eum.go.kr)에서 사람이 수동으로 확인하던 **용도지역·용도지구·용도구역·지구단위계획·도시계획시설·다른 법령 지정사항**을 AI가 자연어로 조회할 수 있게 만든 **Model Context Protocol** 서버입니다.

> **korean-law-mcp** (법령 텍스트) 와 짝이 되는 **공간 레이어 MCP**. 두 MCP를 함께 쓰면 "이 필지가 어디에 속하는가 → 해당 법령·조례가 무엇을 허용/제한하는가" 까지 자연어 한 줄로 연결됩니다.

## ✨ v2.0 아키텍처 원칙

1. **V-World API 전용**. 다른 상용 API·스크래핑·모의(mock) 데이터 없음.
2. **정직한 실패**. 특정 레이어에서 V-World가 500을 던지면 `layer_errors`에 그대로 노출. 절대 가짜 데이터로 채우지 않음.
3. **korean-law-mcp와 역할 분리**. 이 MCP는 "**공간상 어디에 속하는가**"만 답함. 조문 해석은 korean-law-mcp로.
4. **국토계획법 제76조⑤ 우선 위임 자동 감지**. 농업진흥구역·보전산지·상수원보호구역·국가산업단지 등이 필지에 걸리면 `priority_delegation_hint` 로 "국토계획법 시행령 별표 대신 어느 법령을 먼저 봐야 하는가"를 알려줌.

## 🛠️ 제공 도구 (7개)

| 도구 | 설명 |
|---|---|
| `resolve_parcel` | 주소/지번/PNU → 표준화된 PNU·지목·공시지가·행정구역·WGS84 좌표 |
| `get_zoning` | 용도지역 (도시/관리/농림/자연환경) + 용도지구 (8종) + 용도구역 (개발제한·도시자연공원) + 토지거래허가구역 |
| `get_district_plan` | 지구단위계획구역 + 개발행위허가제한구역 |
| `get_urban_facility` | 도시계획시설 9종 (도로·교통·공간·유통공급·공공문화체육·방재·보건위생·환경기초·기타). `radius_m` 파라미터로 "저촉" vs "접함" 구분 |
| `get_other_law_designations` | 42개 다른 법령 지정 레이어 (농지·산림·산업단지·수질환경·축산·문화재·자연공원·특수지구·주거정비·재해·해양·항공). 제76조⑤ 우선 위임 후보 자동 표시 |
| `get_land_attributes` | 지목(28종) 파싱 + 개별공시지가 + 건물 정보 |
| `analyze_parcel` | 위 6개 도구를 한 번에 병렬 호출 + korean-law-mcp 다음 단계 힌트 생성 |

`discover_tools` 도 포함되어 있어 도구 카탈로그를 자연어로 탐색 가능.

## 🆕 v2.1 추가 도구 — 실거래가 · 교통 · 생활인프라

| 도구 | 설명 | 필요한 키 |
|---|---|---|
| `get_real_transactions` | 국토부 실거래가 8개 유형(아파트·오피스텔·연립다세대·단독다가구·상업업무용·토지·공장창고·분양권) 매매/전월세. 거래금액·평단가 사분위, 월별 추이, 단지·용도별 상위, 최근 거래 목록. 주소를 주면 해당 읍면동만 집계 | `DATA_GO_KR_KEY` |
| `get_transit_access` | 반경 내 지하철역(노선별 직선거리·추정 도보시간) + 역세권 등급, 버스정류장·경유노선(유형별). 서울은 서울시 정류소정보, 그 외는 TAGO | `KAKAO_REST_KEY`, `DATA_GO_KR_KEY` |
| `get_drive_times` | 주요 거점까지 자동차 소요시간·거리·통행료. `departure_time` 지정 시 예측 교통(예: 평일 08:00) | `KAKAO_REST_KEY` |
| `get_nearby_facilities` | 학교·어린이집·마트·병원·공공기관 등 18개 카테고리 반경 검색 | `KAKAO_REST_KEY` |

### 키 발급
1. **공공데이터포털(data.go.kr)** → 아래 API를 각각 **활용신청**(대부분 자동승인, 반영까지 최대 1~2시간) → 마이페이지의 **일반 인증키(Decoding)** 를 `DATA_GO_KR_KEY` 로.
   - 국토교통부_아파트 매매 실거래가 자료 / 아파트 전월세 / 오피스텔 매매·전월세 / 연립다세대 매매·전월세 / 단독다가구 매매·전월세 / 상업업무용 부동산 매매 / 토지 매매 / 공장 및 창고 등 매매 / 아파트 분양권전매 — 쓰려는 유형만 신청해도 됩니다.
   - 국토교통부_(TAGO)_버스정류소정보, 서울특별시_정류소정보조회 서비스
2. **Kakao Developers(developers.kakao.com)** → 애플리케이션 추가 → **REST API 키** 를 `KAKAO_REST_KEY` 로. 카카오맵(로컬) 사용 설정, 길찾기는 카카오모빌리티 API 사용 설정이 필요할 수 있습니다.

Fly.io 배포 시: `fly secrets set DATA_GO_KR_KEY=... KAKAO_REST_KEY=...` 후 자동 재배포.

### 사용 예시
- "자양동 680 주변 최근 1년 아파트 매매 평단가 알려줘" → `get_real_transactions(region, "아파트")`
- "성수동 상업업무용 최근 3년 거래사례, 대지 평단가 기준으로" → `get_real_transactions(region, "상업업무용", from_ym)`
- "이 필지 역세권이야? 버스노선은?" → `get_transit_access`
- "평일 8시 출발 강남역·여의도역·판교역까지 차로 몇 분?" → `get_drive_times`

### 알려진 한계
- 실거래가는 신고기한(30일) 때문에 최근 1~2개월이 덜 집계되고, 상업·토지·공장은 지번 일부가 가려집니다.
- 도보시간은 직선거리 기반 추정치이고, 역세권 등급은 일반적 기준(500m/1km)입니다. 사업별 조례 정의는 별도 확인이 필요합니다.
- 오류는 `source_errors`·`month_errors`에 그대로 노출되며 가짜 값으로 채우지 않습니다.

## 📡 V-World 레이어 커버리지

- **용도지역**: `LT_C_UQ111/112/113/114` (도시·관리·농림·자연환경보전 전체)
- **용도지구·구역**: `LT_C_UQ121~130`, `LT_C_UD801`, `LT_C_UQ162`
- **지구단위계획·허가제한**: `LT_C_UPISUQ161`, `LT_C_UPISUQ171`
- **도시계획시설**: `LT_C_UPISUQ151~159`
- **다른 법령 지정**: 농지(AGRIXUE) · 산림(UF) · 산업단지(WGISIE\*, DAM\*) · 수질환경(UM, WGISARWET) · 축산(UM000) · 문화재(UO) · 자연공원(WGISNP\*) · 특수지구(UO/UJ/UH/UB) · 주거정비(UD) · 재해(UP) · 해양(TFISMPA, WGISRE\*) · 항공(AIS\*)
- **필지·건물**: `LP_PA_CBND_BUBUN`, `LT_C_BLDGINFO`, `A2SM_LNDPRCPS`

## 🚀 빠른 시작

### 1. 한 방에 셋업
```bash
git clone https://github.com/UrbanWatcherKr/korean-land-mcp.git
cd korean-land-mcp
npm run setup
```

`npm run setup` 은 `npm install` → `npm run build` → 인터랙티브 **configure** 순으로 실행됩니다. configure 단계에서 V-World API 키·도메인을 묻고 `.env` 파일을 자동 생성합니다.

**V-World API 키 발급**: https://www.vworld.kr/dev/v4api.do (로그인 → 오픈API → 인증키 발급, 무료). 로컬 개발용이면 도메인은 `localhost`로 등록.

### 2. 설정만 다시 하기
API 키를 바꾸거나 도메인을 수정하고 싶으면 언제든:
```bash
npm run configure
```

### 3. Claude Desktop / Claude Code 에 등록
configure 가 끝나면 붙여넣을 JSON 블록을 터미널에 출력합니다. 또는 수동으로:
```json
{
  "mcpServers": {
    "korean-land": {
      "command": "node",
      "args": ["/absolute/path/to/korean-land-mcp/dist/server.js"],
      "env": {
        "VWORLD_API_KEY": "your_real_key_here",
        "VWORLD_DOMAIN": "localhost"
      }
    }
  }
}
```


## 📱 Claude 커스텀 커넥터(원격 MCP)로 배포 — 스마트폰 Claude 앱용

이 포크는 원격 사용을 위해 다음을 보완했습니다: 재접속 시 400 오류가 나던 HTTP 세션 문제(무상태 처리), Docker 빌드 실패(typescript 누락), 접근 토큰 인증, `/health` 확인 주소, 지적도 그림 도구 `get_cadastral_map`(면적 포함).

**반드시 국내 리전에 배포하세요.** V-World는 해외 IP 접속을 차단할 수 있습니다.

| 환경변수 | 값 |
|---|---|
| `VWORLD_API_KEY` | V-World 인증키 |
| `VWORLD_DOMAIN` | 배포 주소(V-World 인증키의 서비스 URL과 동일) |
| `DATA_GO_KR_KEY` | 공공데이터포털 일반 인증키 (실거래가·버스) |
| `KAKAO_REST_KEY` | 카카오 REST API 키 (역·주변시설·소요시간) |
| `MCP_TOKEN` | 커넥터 접근용 비밀 문자열 |
| `MCP_TRANSPORT` | `http` (Dockerfile에 기본 설정됨) |
| `PORT` | `8080` (Dockerfile 기본) |

Claude 등록: claude.ai → 설정 → 커넥터 → 커스텀 커넥터 → URL `https://<배포주소>/mcp`, 인증 No sign in, 요청 헤더 `Authorization: Bearer <MCP_TOKEN>`.

## 💬 사용 예시

- "경기도 평택시 포승읍 내기리 680 용도지역 알려줘" → `get_zoning`
- "이 필지에 제76조⑤ 우선 위임 적용되는지 체크해줘" → `get_other_law_designations`
- "반경 50m 안에 도시계획시설 저촉·접함 있어?" → `get_urban_facility({ radius_m: 50 })`
- "이 지번 전체 분석하고 korean-law 다음 단계 알려줘" → `analyze_parcel`

## 🧭 korean-law-mcp 와의 워크플로우

```
사용자: "이 지번에 공장 지을 수 있어?"
  ↓
korean-land-mcp · analyze_parcel
  ↓ (용도지역=일반공업, 산업단지=아산포승, 우선위임=산업입지법)
korean-law-mcp · search_law("산업입지법")
  ↓
korean-law-mcp · get_law_text(산업입지법 제33조)
  ↓
결론 + 원문 근거
```

## 🗂️ 프로젝트 구조

```
src/
├── server.ts                          # MCP stdio 엔트리, 7개 도구 등록
├── lib/
│   ├── vworld.ts                      # V-World HTTP 클라이언트 (5xx 재시도 1회)
│   ├── overlays.ts                    # 병렬 레이어 쿼리 + POINT/BOX 필터
│   ├── resolve.ts                     # 주소/지번/PNU 해석
│   └── jimok.ts                       # 지목 코드 28종 매핑
└── tools/
    ├── resolve_parcel.ts
    ├── get_zoning.ts
    ├── get_district_plan.ts
    ├── get_urban_facility.ts
    ├── get_other_law_designations.ts
    ├── get_land_attributes.ts
    └── analyze_parcel.ts
```

## 🧪 테스트

**유닛 테스트** (순수 함수, API 키 불필요):
```bash
npm test
```

**Live smoke test** (실제 V-World 호출, `VWORLD_API_KEY` 필요):
```bash
# 단일 지번 디버그
npx tsx tests/live/smoke-polygon.ts "서울특별시 마포구 연남동 229-1"

# 3개 픽스처 회귀 테스트 (스냅샷 비교)
npx tsx tests/live/smoke-fixtures.ts

# 스냅샷 갱신 (V-World 데이터 변경 시)
npx tsx tests/live/smoke-fixtures.ts --update
```

Fixtures: 도시 주거지(연남동), 농림지역+우선위임(세출리), 복합 용도지역+도시개발(갈매리).

## ⚠️ 알려진 한계

- **점 기반 판정**: 기본 쿼리는 필지 중심점 1개를 V-World에 던진다. 필지 폴리곤 교차가 아니므로 경계에 걸친 케이스는 놓칠 수 있음. `get_urban_facility` 의 `radius_m` 는 BOX 필터로 이 한계를 완화하지만, "저촉" vs "접함" 최종 판정은 사용자 또는 담당 공무원의 폴리곤 교차 재검증이 필요.
- **V-World 레이어 장애**: 일부 레이어가 간헐적으로 HTTP 500을 반환함. 5xx 1회 재시도 후에도 실패 시 `layer_errors` 에 노출되며, 나머지 레이어 결과는 정상 반환된다.
- **지자체 조례 미포함**: 이 MCP는 공간 레이어만. 지자체 도시계획조례 조문은 **korean-law-mcp** 또는 법제처 자치법규 API로 별도 조회.

## 📜 라이선스

MIT License.

## 🤝 기여

이슈·PR 환영. 새 V-World 레이어 추가 시 `src/tools/*.ts` 의 `LAYERS` 배열에 `{ id, label }` 만 추가하면 자동으로 `queryOverlays` 파이프라인에 편입됩니다.
