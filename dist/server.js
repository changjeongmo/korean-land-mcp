import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import dotenv from "dotenv";
import { z } from "zod";
import { resolveParcelTool } from "./tools/resolve_parcel.js";
import { getZoningTool } from "./tools/get_zoning.js";
import { getDistrictPlanTool } from "./tools/get_district_plan.js";
import { getUrbanFacilityTool } from "./tools/get_urban_facility.js";
import { getOtherLawDesignationsTool } from "./tools/get_other_law_designations.js";
import { getLandAttributesTool } from "./tools/get_land_attributes.js";
import { analyzeParcelTool } from "./tools/analyze_parcel.js";
import { getCadastralMapTool } from "./tools/get_cadastral_map.js";
import { getRealTransactionsTool } from "./tools/get_real_transactions.js";
import { getTransitAccessTool } from "./tools/get_transit_access.js";
import { getDriveTimesTool } from "./tools/get_drive_times.js";
import { getNearbyFacilitiesTool } from "./tools/get_nearby_facilities.js";
import { KAKAO_CATEGORIES } from "./lib/kakao.js";
dotenv.config();
function createServer() {
    const server = new McpServer({
        name: "korean-land-mcp",
        version: "2.1.0",
        description: "Korean parcel & zoning MCP backed by V-World. Resolves addresses/PNUs into spatial facts (필지, 용도지역/지구/구역, 지구단위계획, 도시계획시설, 다른 법령 지정사항). Also: 국토부 실거래가 (DATA_GO_KR_KEY) and 교통·생활인프라 (KAKAO_REST_KEY). No mock fallback — failures are real errors. For 법령·조례 text, pair with korean-law MCP.",
    });
    const QUERY_SCHEMA = {
        query: z
            .string()
            .min(2)
            .describe("Korean address (e.g. '경기도 평택시 포승읍 내기리 680') or 19-digit PNU"),
    };
    server.tool("resolve_parcel", "Resolve address or PNU → canonical parcel: PNU, 지번, parsed 지목 (e.g. 공장용지), refined address, WGS84 coordinates, 공시지가, administrative hierarchy. Foundation for all other tools.", QUERY_SCHEMA, resolveParcelTool);
    server.tool("get_zoning", "Return 용도지역 (도시/관리/농림/자연환경보전 + subclass), 용도지구 (경관/고도/방화/방재/보호/취락/개발진흥/특정용도제한), 용도구역 (개발제한/도시자연공원), and 토지거래허가구역 overlays. Empty array = no overlay at this point (not an error). Use the zone name with korean-law MCP to get 건폐율·용적률.", QUERY_SCHEMA, getZoningTool);
    server.tool("get_district_plan", "Return 지구단위계획구역 membership and 개발행위허가제한지역 overlays. When district_plan is non-empty, 건폐율·용적률·용도 may be overridden by the plan (see 국토계획법 제52조). V-World only returns the geometric hit — actual plan text must come from 지자체 고시문.", QUERY_SCHEMA, getDistrictPlanTool);
    server.tool("get_urban_facility", "Return 도시계획시설 overlaps: 도로, 교통시설, 공간시설(공원·녹지), 유통공급, 공공문화체육, 방재, 보건위생, 환경기초, 기타기반시설. Overlap with 도시계획시설 triggers 건축제한 (국계법 제64조) or 미집행 저촉 리스크. Exact 저촉 면적 needs geometric intersection, not returned here.", {
        ...QUERY_SCHEMA,
        radius_m: z
            .number()
            .int()
            .min(0)
            .max(500)
            .optional()
            .describe("접함(nearby) 후보 탐지 반경(미터). 기본 50. 0이면 저촉(overlap)만 반환. 최대 500."),
    }, getUrbanFacilityTool);
    server.tool("get_other_law_designations", "Return '다른 법령에 따른 지정사항' overlays — ~38 layers across 농지/산림/산업단지/수질·환경/축산/문화재/자연공원/특수지구/주거정비/재해/해양/항공. Each hit includes governing_law and a triggers_priority_delegation flag. When any flag is true, 국토계획법 제76조⑤ priority delegation applies and the governing_law's 행위제한 overrides the 국토계획법 시행령 별표 — look up those provisions via korean-law MCP first.", QUERY_SCHEMA, getOtherLawDesignationsTool);
    server.tool("get_land_attributes", "Return detailed parcel attributes: parsed 지목 (28-type mapping), 지번 components, 공시지가, administrative breakdown, and 건축물 presence at the point. Note: 면적(land area) is NOT provided — V-World doesn't expose 토지대장 area field.", QUERY_SCHEMA, getLandAttributesTool);
    server.tool("analyze_parcel", "One-shot comprehensive analysis — chains all the above tools and returns a single integrated record: parcel + zoning + district_plan + urban_facility + other_law_designations + priority_delegation_hint + buildings + next_steps. Use this when you want a complete 토지이용계획확인서-equivalent JSON in one call. next_steps tells you exactly which korean-law MCP queries to run afterward.", QUERY_SCHEMA, analyzeParcelTool);
    server.tool("discover_tools", "List all currently wired tools in this MCP build.", {}, async () => ({
        content: [
            {
                type: "text",
                text: [
                    "korean-land-mcp v2.1 — V-World + 실거래가 + 교통 (mock fallback 없음)",
                    "",
                    "Tools:",
                    "- resolve_parcel(query): address|PNU → canonical parcel",
                    "- get_zoning(query): 용도지역·지구·구역 + 토지거래허가구역",
                    "- get_district_plan(query): 지구단위계획 + 개발행위허가제한",
                    "- get_urban_facility(query): 도시계획시설 9개 카테고리",
                    "- get_other_law_designations(query): 38개 개별법령 지정 (국계법 76조⑤ 우선위임 힌트 포함)",
                    "- get_land_attributes(query): 지목 파싱 + 공시지가 + 건물 유무",
                    "- analyze_parcel(query): 위 전체를 1회 호출로 체이닝",
                    "- get_cadastral_map(query, buffer_m?): 연속지적도(지적도+임야도) PNG + 면적",
                    "",
                    "[실거래가 — DATA_GO_KR_KEY]",
                    "- get_real_transactions(region, property_type, deal_kind?, from_ym?, to_ym?, ...): 국토부 실거래가 매매·전월세 + 단가·월별추이 통계",
                    "",
                    "[교통·생활인프라 — KAKAO_REST_KEY (+버스는 DATA_GO_KR_KEY)]",
                    "- get_transit_access(query, subway_radius_m?, bus_radius_m?): 지하철역·역세권 판정·버스정류장·경유노선",
                    "- get_drive_times(query, destinations[], departure_time?): 주요 거점까지 자동차 소요시간(실시간/예측)",
                    "- get_nearby_facilities(query, categories?, radius_m?): 학교·마트·병원 등 주변 시설",
                    "",
                    "Legal citations (법령·조례 원문) are intentionally out of scope — use korean-law MCP.",
                ].join("\n"),
            },
        ],
    }));
    server.tool("get_cadastral_map", "Draw the 연속지적도 (지적도+임야도 merged cadastral map) around a parcel as a PNG image: target parcel in red, neighbouring parcels with 지번·지목 labels, scale bar. Also returns 면적(㎡·평) from V-World 토지특성. Use for 입지분석·기획설계 site context. For 임야 include '산' in the address.", {
        ...QUERY_SCHEMA,
        buffer_m: z
            .number()
            .int()
            .min(20)
            .max(500)
            .optional()
            .describe("대상 필지 바깥으로 보여줄 범위(미터). 기본 60, 20~500."),
    }, getCadastralMapTool);
    server.tool("get_real_transactions", "국토교통부 실거래가 조회·집계. 유형: 아파트/오피스텔/연립다세대/단독다가구/상업업무용/토지/공장창고/분양권, 매매 또는 전월세(주거 4종). region은 지번주소·PNU·5자리 시군구코드. 주소를 주면 기본으로 해당 읍면동만 집계(scope='sigungu'로 시군구 전체). 결과: 거래금액·평단가 분포(사분위), 월별 추이, 단지·용도별 상위, 최근 거래 목록. 사업수지의 분양가·매입가 비교사례 근거로 사용. 금액 단위 만원. Requires DATA_GO_KR_KEY.", {
        region: z.string().min(2).describe("지번주소(예: '서울특별시 광진구 자양동 680'), 19자리 PNU, 또는 5자리 시군구코드(LAWD_CD, 예: '11215')"),
        property_type: z
            .enum(["아파트", "오피스텔", "연립다세대", "단독다가구", "상업업무용", "토지", "공장창고", "분양권"])
            .describe("부동산 유형"),
        deal_kind: z.enum(["매매", "전월세"]).optional().describe("기본 매매. 전월세는 아파트·오피스텔·연립다세대·단독다가구만"),
        from_ym: z.string().regex(/^\d{6}$/).optional().describe("시작 계약년월 YYYYMM. 기본: to_ym 기준 11개월 전(최근 12개월)"),
        to_ym: z.string().regex(/^\d{6}$/).optional().describe("종료 계약년월 YYYYMM. 기본: 이번 달. 최대 36개월"),
        scope: z.enum(["dong", "sigungu"]).optional().describe("주소 입력 시 집계 범위. 기본 dong(읍면동)"),
        dong: z.string().optional().describe("법정동명 필터(부분일치, 예: '자양동'). 지정 시 scope보다 우선"),
        name_contains: z.string().optional().describe("단지명 부분일치 필터(아파트·오피스텔·연립·분양권)"),
        min_area_m2: z.number().optional().describe("기준면적 하한(㎡) — 아파트 등 전용, 단독 연면적, 상업·공장 건물면적, 토지 거래면적"),
        max_area_m2: z.number().optional().describe("기준면적 상한(㎡)"),
        include_canceled: z.boolean().optional().describe("해제(취소)된 거래 포함 여부. 기본 false"),
        max_list: z.number().int().min(0).max(200).optional().describe("최근 거래 목록 최대 건수. 기본 30"),
    }, getRealTransactionsTool);
    server.tool("get_transit_access", "대중교통 접근성: 반경 내 지하철·전철역(노선별, 직선거리·추정 도보시간)과 역세권 등급, 버스정류장과 경유노선(유형별 집계). 서울은 서울시 정류소정보, 그 외 지역은 국토부 TAGO. 교통현황분석·입지분석 보고서용. Requires KAKAO_REST_KEY (역) and DATA_GO_KR_KEY (버스).", {
        ...QUERY_SCHEMA,
        subway_radius_m: z.number().int().min(100).max(5000).optional().describe("역 검색 반경(m). 기본 1500"),
        bus_radius_m: z.number().int().min(100).max(1500).optional().describe("버스정류장 검색 반경(m). 기본 500"),
        max_bus_stops_with_routes: z.number().int().min(0).max(15).optional().describe("경유노선까지 조회할 가까운 정류장 수. 기본 6"),
    }, getTransitAccessTool);
    server.tool("get_drive_times", "대상지에서 주요 거점(도심·업무지구·IC·KTX역 등)까지 자동차 소요시간·거리·통행료. departure_time을 주면 카카오모빌리티 예측 교통(예: 평일 08:00 출근시간), 없으면 실시간. 목적지는 장소명('강남역', '판교IC') 또는 주소. Requires KAKAO_REST_KEY.", {
        ...QUERY_SCHEMA,
        destinations: z.array(z.string().min(1)).min(1).max(10).describe("목적지 장소명 또는 주소 목록(최대 10)"),
        departure_time: z.string().optional().describe("출발 일시(미래). 예: '2026-10-21 08:00'. 생략 시 실시간"),
        priority: z.enum(["RECOMMEND", "TIME", "DISTANCE"]).optional().describe("경로 우선순위. 기본 RECOMMEND"),
    }, getDriveTimesTool);
    server.tool("get_nearby_facilities", `대상지 반경 내 생활인프라(카카오 로컬). 카테고리: ${Object.keys(KAKAO_CATEGORIES).join(", ")}. 기본: 학교·어린이집·유치원·대형마트·병원·공공기관·은행. 입지분석의 교육·상업·의료 인프라 항목용. Requires KAKAO_REST_KEY.`, {
        ...QUERY_SCHEMA,
        categories: z.array(z.string()).max(10).optional().describe("카테고리 이름 목록(위 목록의 한글 이름)"),
        radius_m: z.number().int().min(50).max(20000).optional().describe("반경(m). 기본 1000"),
        max_per_category: z.number().int().min(1).max(45).optional().describe("카테고리별 최대 목록 수. 기본 10"),
    }, getNearbyFacilitiesTool);
    return server;
}
const transportType = process.env.MCP_TRANSPORT || "stdio";
if (transportType === "http") {
    const app = express();
    app.use(express.json({ limit: "4mb" }));
    // Optional shared-secret auth for public deployments (Claude custom connector → Request headers).
    const TOKEN = (process.env.MCP_TOKEN || "").trim();
    app.use("/mcp", (req, res, next) => {
        if (!TOKEN)
            return next();
        const auth = req.header("authorization") || "";
        const got = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : String(req.query.token ?? "");
        if (got !== TOKEN)
            return res.status(401).json({ error: "unauthorized" });
        next();
    });
    app.get(["/", "/health"], (_req, res) => {
        res.type("text/plain").send("korean-land-mcp OK — endpoint: /mcp");
    });
    // Stateless Streamable HTTP: a fresh server+transport per request, so every Claude
    // reconnect (mobile app, web, desktop) can initialize without session conflicts.
    app.post("/mcp", async (req, res) => {
        const server = createServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
            transport.close();
            server.close();
        });
        try {
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        }
        catch (e) {
            console.error("MCP request error", e);
            if (!res.headersSent) {
                res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
            }
        }
    });
    const methodNotAllowed = (_req, res) => {
        res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
    };
    app.get("/mcp", methodNotAllowed);
    app.delete("/mcp", methodNotAllowed);
    const PORT = Number(process.env.PORT || 3000);
    app.listen(PORT, "0.0.0.0", () => {
        console.error(`korean-land-mcp v2.1 HTTP on :${PORT}/mcp (auth ${TOKEN ? "on" : "off"})`);
    });
}
else {
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("korean-land-mcp v2.1 ready (stdio) — 12 tools wired");
}
//# sourceMappingURL=server.js.map