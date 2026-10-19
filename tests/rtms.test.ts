import { describe, it, expect, vi, afterEach } from "vitest";
import axios from "axios";
import { parseDataGoKrBody, num, DataGoKrError, getDataGoKrKey } from "../src/lib/datagokr.js";
import {
  normalizeDeal,
  describe as stat,
  monthRange,
  shiftYm,
  currentYmKst,
  summarizeRents,
  endpointFor,
} from "../src/lib/rtms.js";
import { getRealTransactionsTool } from "../src/tools/get_real_transactions.js";

const APT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<response><header><resultCode>000</resultCode><resultMsg>OK</resultMsg></header>
<body><items>
<item><aptNm>래미안</aptNm><buildYear>2015</buildYear><cdealType> </cdealType><dealAmount>   125,000</dealAmount><dealDay>7</dealDay><dealMonth>3</dealMonth><dealYear>2026</dealYear><dealingGbn>중개거래</dealingGbn><excluUseAr>84.97</excluUseAr><floor>12</floor><jibun>680</jibun><umdNm>자양동</umdNm></item>
<item><aptNm>래미안</aptNm><buildYear>2015</buildYear><cdealType>O</cdealType><dealAmount>99,000</dealAmount><dealDay>20</dealDay><dealMonth>3</dealMonth><dealYear>2026</dealYear><dealingGbn>직거래</dealingGbn><excluUseAr>59.9</excluUseAr><floor>3</floor><jibun>680</jibun><umdNm>자양동</umdNm></item>
<item><aptNm>현대</aptNm><buildYear>1998</buildYear><dealAmount>80,000</dealAmount><dealDay>2</dealDay><dealMonth>3</dealMonth><dealYear>2026</dealYear><excluUseAr>59.5</excluUseAr><floor>5</floor><jibun>1</jibun><umdNm>구의동</umdNm></item>
</items><numOfRows>1000</numOfRows><pageNo>1</pageNo><totalCount>3</totalCount></body></response>`;

describe("datagokr parser", () => {
  it("parses RTMS XML items", () => {
    const r = parseDataGoKrBody(APT_XML, "t");
    expect(r.totalCount).toBe(3);
    expect(r.items[0].aptNm).toBe("래미안");
    expect(r.items[0].dealAmount).toBe("125,000");
  });

  it("parses TAGO JSON with single item object and empty items", () => {
    const one = parseDataGoKrBody(
      JSON.stringify({ response: { header: { resultCode: "00" }, body: { items: { item: { nodenm: "A", gpslati: 37.1 } }, totalCount: 1 } } }),
      "t"
    );
    expect(one.items).toEqual([{ nodenm: "A", gpslati: "37.1" }]);
    const none = parseDataGoKrBody(JSON.stringify({ response: { header: { resultCode: "00" }, body: { items: "", totalCount: 0 } } }), "t");
    expect(none.items).toEqual([]);
  });

  it("throws on gateway key error", () => {
    const x = `<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg><returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>`;
    expect(() => parseDataGoKrBody(x, "t")).toThrow(DataGoKrError);
  });

  it("throws on non-OK resultCode", () => {
    const x = `<response><header><resultCode>22</resultCode><resultMsg>LIMITED NUMBER OF SERVICE REQUESTS EXCEEDS ERROR</resultMsg></header></response>`;
    expect(() => parseDataGoKrBody(x, "t")).toThrow(/resultCode 22/);
  });

  it("num handles commas and blanks", () => {
    expect(num(" 125,000 ")).toBe(125000);
    expect(num("")).toBeNull();
    expect(num("abc")).toBeNull();
  });

  it("decodes an Encoding-type key", () => {
    process.env.DATA_GO_KR_KEY = "abc%2Bdef%3D%3D";
    expect(getDataGoKrKey()).toBe("abc+def==");
    process.env.DATA_GO_KR_KEY = "abc+def==";
    expect(getDataGoKrKey()).toBe("abc+def==");
  });
});

describe("rtms normalize & stats", () => {
  it("normalizes an apartment trade", () => {
    const row = parseDataGoKrBody(APT_XML, "t").items[0];
    const d = normalizeDeal(row, "아파트", "매매");
    expect(d.date).toBe("2026-03-07");
    expect(d.price_manwon).toBe(125000);
    expect(d.area_m2).toBe(84.97);
    expect(d.unit_manwon_per_pyeong).toBeCloseTo((125000 / 84.97) * 3.305785, 0);
    expect(d.canceled).toBe(false);
    const c = normalizeDeal(parseDataGoKrBody(APT_XML, "t").items[1], "아파트", "매매");
    expect(c.canceled).toBe(true);
  });

  it("normalizes commercial trade with land unit price and share deal", () => {
    const d = normalizeDeal(
      {
        dealYear: "2025",
        dealMonth: "11",
        dealDay: "3",
        dealAmount: "330,000",
        buildingAr: "500",
        plottageAr: "330.5785",
        buildingUse: "제2종근린생활",
        landUse: "제2종일반주거",
        jibun: "1**",
        shareDealingType: "지분",
      },
      "상업업무용",
      "매매"
    );
    expect(d.building_use).toBe("제2종근린생활");
    expect(d.zoning).toBe("제2종일반주거");
    expect(d.land_unit_manwon_per_pyeong).toBeCloseTo(3300, 0);
    expect(d.share_deal).toBe(true);
  });

  it("supports legacy Korean field names", () => {
    const d = normalizeDeal({ 년: "2023", 월: "1", 일: "5", 거래금액: "50,000", 전용면적: "50", 아파트: "옛단지", 법정동: "가동" }, "아파트", "매매");
    expect(d.name).toBe("옛단지");
    expect(d.date).toBe("2023-01-05");
  });

  it("summarizes rents into 전세/월세", () => {
    const rows = [
      { deposit: "50,000", monthlyRent: "0", excluUseAr: "84", contractType: "신규" },
      { deposit: "10,000", monthlyRent: "120", excluUseAr: "59", contractType: "갱신" },
    ].map((r) => normalizeDeal(r, "아파트", "전월세"));
    const s = summarizeRents(rows);
    expect(s.jeonse.count).toBe(1);
    expect(s.wolse.monthly_rent_manwon.median).toBe(120);
    expect(s.new_vs_renewal).toEqual({ 신규: 1, 갱신: 1 });
  });

  it("describe computes quartiles", () => {
    const s = stat([1, 2, 3, 4, null]);
    expect(s).toMatchObject({ count: 4, min: 1, median: 2.5, max: 4, mean: 2.5 });
  });

  it("month helpers", () => {
    expect(monthRange("202511", "202602")).toEqual(["202511", "202512", "202601", "202602"]);
    expect(shiftYm("202603", -11)).toBe("202504");
    expect(shiftYm("202512", 1)).toBe("202601");
    expect(currentYmKst(new Date("2026-10-31T16:00:00Z"))).toBe("202611");
  });

  it("rejects rent for non-residential types", () => {
    expect(() => endpointFor("토지", "전월세")).toThrow();
  });
});

describe("get_real_transactions (mocked HTTP)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("aggregates months, filters dong and canceled deals", async () => {
    process.env.DATA_GO_KR_KEY = "k";
    const spy = vi.spyOn(axios, "get").mockResolvedValue({ status: 200, data: APT_XML } as never);
    const res = await getRealTransactionsTool({
      region: "11215",
      property_type: "아파트",
      from_ym: "202603",
      to_ym: "202604",
      dong: "자양동",
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][0]).toContain("RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade");
    const out = JSON.parse(res.content[0].text);
    expect(out.counts.sigungu_rows).toBe(6);
    expect(out.counts.canceled_excluded).toBe(2);
    expect(out.counts.after_filters).toBe(2); // 자양동 정상거래 1건 × 2개월
    expect(out.summary.price_manwon.median).toBe(125000);
    expect(out.summary.top_groups[0].key).toBe("래미안");
  });
});
