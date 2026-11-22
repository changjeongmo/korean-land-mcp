import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import axios from "axios";
import {
  zipParams,
  groupOperations,
  buildOperations,
  assertAllowedUrl,
  normalizeResponse,
  summarizeSwagger,
  callApi,
  searchCatalog,
  describeApi,
} from "../src/lib/publicdata.js";

const KEY = "abc+def/ghi==";

beforeEach(() => {
  process.env.DATA_GO_KR_KEY = KEY;
});
afterEach(() => vi.restoreAllMocks());

const ROWS = [
  {
    list_id: "15057511", list_title: "국토교통부_아파트 매매 실거래가 자료", title: "아파트 매매 실거래가", org_nm: "국토교통부",
    end_point_url: "https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade", operation_nm: "getRTMSDataSvcAptTrade", operation_url: "",
    request_param_nm_en: "serviceKey,LAWD_CD,DEAL_YMD,pageNo,numOfRows", request_param_nm: "서비스키,지역코드,계약월,페이지번호,한페이지결과수",
    response_param_nm_en: "aptNm,dealAmount", response_param_nm: "단지명,거래금액",
    is_confirmed_for_dev_nm: "자동승인", is_deleted: "N", is_list_deleted: "N", updated_at: "2026-01-01",
  },
  { list_id: "15057511", list_title: "국토교통부_아파트 매매 실거래가 자료", org_nm: "국토교통부", operation_nm: "getRTMSDataSvcAptTrade", is_deleted: "N" },
  { list_id: "1", list_title: "폐기된 API", org_nm: "X", operation_nm: "op", is_deleted: "Y" },
];

describe("catalog helpers", () => {
  it("zips param names", () => {
    expect(zipParams("a,b", "가,나")).toEqual([{ name: "a", label: "가" }, { name: "b", label: "나" }]);
    expect(zipParams("a,b,c", "가")).toHaveLength(4); // mismatch → both lists exposed
    expect(zipParams(undefined, "가,나")).toEqual([{ name: "가" }, { name: "나" }]);
  });
  it("groups operations by list_id and drops retired", () => {
    const g = groupOperations(ROWS);
    expect(g).toHaveLength(1);
    expect(g[0].operations).toEqual(["getRTMSDataSvcAptTrade"]);
    expect(g[0].detail_url).toBe("https://www.data.go.kr/data/15057511/openapi.do");
  });
  it("builds call_url from endpoint + operation", () => {
    const ops = buildOperations(ROWS);
    expect(ops[0].call_url).toBe("https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade");
    expect(ops[0].request_params[1]).toEqual({ name: "LAWD_CD", label: "지역코드" });
  });
});

describe("host allowlist", () => {
  it("allows public hosts and upgrades gateway to https", () => {
    expect(assertAllowedUrl("http://apis.data.go.kr/x").protocol).toBe("https:");
    expect(assertAllowedUrl("http://openapi.molit.go.kr:8081/x").hostname).toBe("openapi.molit.go.kr");
    expect(assertAllowedUrl("https://api.odcloud.kr/api/x").hostname).toBe("api.odcloud.kr");
  });
  it("blocks others", () => {
    expect(() => assertAllowedUrl("https://evil.com/x")).toThrow(/허용되지 않은/);
    expect(() => assertAllowedUrl("https://data.go.kr.evil.com/x")).toThrow();
    expect(() => assertAllowedUrl("http://169.254.169.254/latest")).toThrow(/IP/);
    expect(() => assertAllowedUrl("file:///etc/passwd")).toThrow();
  });
});

describe("normalizeResponse", () => {
  it("gateway XML", () => {
    const n = normalizeResponse(
      `<response><header><resultCode>00</resultCode><resultMsg>OK</resultMsg></header><body><items><item><a>1</a></item><item><a>2</a></item></items><totalCount>7</totalCount></body></response>`,
      "t"
    );
    expect(n.style).toBe("gateway");
    expect(n.rows).toHaveLength(2);
    expect(n.totalCount).toBe(7);
  });
  it("gateway auth error → hintable error", () => {
    expect(() =>
      normalizeResponse(
        `<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg><returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>`,
        "t"
      )
    ).toThrow(/NOT_REGISTERED/);
  });
  it("odcloud JSON", () => {
    const n = normalizeResponse(JSON.stringify({ page: 1, perPage: 10, totalCount: 3, currentCount: 2, matchCount: 2, data: [{ x: 1 }, { x: 2 }] }), "t");
    expect(n.style).toBe("odcloud");
    expect(n.totalCount).toBe(2);
  });
  it("gateway JSON (_type=json) single item", () => {
    const n = normalizeResponse(JSON.stringify({ response: { header: { resultCode: "00" }, body: { items: { item: { a: "1" } }, totalCount: 1 } } }), "t");
    expect(n.rows).toEqual([{ a: "1" }]);
  });
  it("agency custom JSON → first array", () => {
    const n = normalizeResponse(JSON.stringify({ SomeService: { list_total_count: 2, row: [{ a: 1 }, { a: 2 }] } }), "t");
    expect(n.style).toBe("raw");
    expect(n.rows).toHaveLength(2);
  });
});

describe("swagger summary", () => {
  it("swagger2 with $ref", () => {
    const spec = {
      swagger: "2.0", host: "api.odcloud.kr", basePath: "/api", schemes: ["https"], info: { title: "T" },
      paths: { "/15000000/v1/uddi:abc": { get: { summary: "s", parameters: [{ name: "page", in: "query" }, { name: "serviceKey", in: "query" }], responses: { "200": { schema: { $ref: "#/definitions/R" } } } } } },
      definitions: { R: { properties: { data: { type: "array", items: { $ref: "#/definitions/M" } }, page: {} } }, M: { properties: { 주소: { description: "도로명" }, 면적: {} } } },
    };
    const s = summarizeSwagger(spec);
    expect(s.operations[0].call_url).toBe("https://api.odcloud.kr/api/15000000/v1/uddi:abc");
    expect(s.operations[0].params.map((p: any) => p.name)).toEqual(["page"]);
    expect(s.operations[0].response_fields).toContain("면적");
  });
});

describe("callApi", () => {
  it("injects key, strips user key, paginates, masks key", async () => {
    const calls: any[] = [];
    vi.spyOn(axios, "request").mockImplementation(async (cfg: any) => {
      calls.push(cfg);
      const p = cfg.params.pageNo;
      const items = p === 1 ? "<item><a>1</a></item><item><a>2</a></item>" : "<item><a>3</a></item>";
      return { status: 200, headers: { "content-type": "text/xml;charset=UTF-8" }, data: Buffer.from(`<response><header><resultCode>00</resultCode></header><body><items>${items}</items><totalCount>3</totalCount></body></response>`) } as any;
    });
    const txt = await callApi({ url: "https://apis.data.go.kr/1613000/X/getX?LAWD_CD=11215&serviceKey=LEAK", params: { DEAL_YMD: "202609", ServiceKey: "LEAK2" }, all_pages: true, page_size: 2, max_rows: 10 });
    const out = JSON.parse(txt);
    expect(out.rows.map((r: any) => r.a)).toEqual(["1", "2", "3"]);
    expect(calls).toHaveLength(2);
    expect(calls[0].params.serviceKey).toBe(KEY);
    expect(calls[0].params.LAWD_CD).toBe("11215");
    expect(calls[0].params.ServiceKey).toBeUndefined();
    expect(calls[0].url).not.toContain("LEAK");
    expect(txt).not.toContain(KEY);
  });

  it("decodes EUC-KR", async () => {
    // "가" in EUC-KR = 0xB0 0xA1
    const body = Buffer.concat([Buffer.from('<?xml version="1.0" encoding="EUC-KR"?><response><header><resultCode>00</resultCode></header><body><items><item><n>'), Buffer.from([0xb0, 0xa1]), Buffer.from("</n></item></items><totalCount>1</totalCount></body></response>")]);
    vi.spyOn(axios, "request").mockResolvedValue({ status: 200, headers: { "content-type": "text/xml" }, data: body } as any);
    const out = JSON.parse(await callApi({ url: "https://apis.data.go.kr/a/b" }));
    expect(out.rows[0].n).toBe("가");
  });

  it("odcloud: Infuser header + page/perPage", async () => {
    const spy = vi.spyOn(axios, "request").mockResolvedValue({ status: 200, headers: {}, data: Buffer.from(JSON.stringify({ page: 1, perPage: 100, currentCount: 1, matchCount: 1, totalCount: 1, data: [{ k: 1 }] })) } as any);
    await callApi({ url: "https://api.odcloud.kr/api/15000000/v1/uddi:x", params: { "cond[시도::EQ]": "서울" } });
    const cfg: any = spy.mock.calls[0][0];
    expect(cfg.headers.Authorization).toBe(`Infuser ${KEY}`);
    expect(cfg.params.page).toBe(1);
    expect(cfg.params.perPage).toBe(100);
    expect(cfg.params["cond[시도::EQ]"]).toBe("서울");
  });

  it("error code 30 gives 활용신청 hint and link", async () => {
    vi.spyOn(axios, "request").mockResolvedValue({ status: 200, headers: {}, data: Buffer.from(`<OpenAPI_ServiceResponse><cmmMsgHeader><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg><returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>`) } as any);
    await expect(callApi({ url: "https://apis.data.go.kr/a/b", list_id: "15057511" })).rejects.toThrow(/활용신청.*15057511/);
  });
});

describe("catalog calls", () => {
  it("search groups and filters extra words; falls back to title", async () => {
    const spy = vi.spyOn(axios, "get").mockImplementation(async (_url: any, cfg: any) => {
      const hasListTitle = "cond[list_title::LIKE]" in cfg.params;
      const data = hasListTitle ? [] : ROWS;
      return { status: 200, data: JSON.stringify({ page: 1, perPage: 1000, totalCount: 3, currentCount: 3, matchCount: data.length, data }) } as any;
    });
    const r = await searchCatalog({ keyword: "실거래가 아파트" });
    expect(r.openapi.apis_found).toBe(1);
    expect(r.openapi.matched_via).toContain("title");
    expect((spy.mock.calls[0][1] as any).headers.Authorization).toBe(`Infuser ${KEY}`);
  });

  it("describe returns operations", async () => {
    vi.spyOn(axios, "get").mockResolvedValue({ status: 200, data: JSON.stringify({ data: ROWS.slice(0, 2), matchCount: 2 }) } as any);
    const d = await describeApi({ list_id: "15057511" });
    expect(d.operations[0].call_url).toContain("getRTMSDataSvcAptTrade");
    expect(d.api.auto_approval.dev).toBe("자동승인");
  });

  it("catalog not subscribed → clear guidance", async () => {
    vi.spyOn(axios, "get").mockResolvedValue({ status: 401, data: '{"code":-401,"msg":"유효하지 않은 인증키"}' } as any);
    await expect(searchCatalog({ keyword: "공시지가" })).rejects.toThrow(/15077093/);
  });
});
