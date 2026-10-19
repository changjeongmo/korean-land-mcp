import { describe, it, expect, vi, afterEach } from "vitest";
import axios from "axios";
import { haversineM, estimateWalkMin, categorySearch, drivingRoute, KakaoError } from "../src/lib/kakao.js";
import { nearbyBusStops, routesForStop } from "../src/lib/bus.js";
import { normalizeDeparture } from "../src/tools/get_drive_times.js";

afterEach(() => vi.restoreAllMocks());

describe("distance helpers", () => {
  it("haversine ~ 111km per degree latitude", () => {
    expect(haversineM({ x: 127, y: 37 }, { x: 127, y: 38 })).toBeGreaterThan(110_000);
    expect(haversineM({ x: 127, y: 37 }, { x: 127, y: 38 })).toBeLessThan(112_000);
  });
  it("walk estimate 500m ≈ 10min", () => {
    expect(estimateWalkMin(500)).toBe(10);
  });
});

describe("kakao", () => {
  it("requires KAKAO_REST_KEY", async () => {
    delete process.env.KAKAO_REST_KEY;
    await expect(categorySearch("SW8", { x: 127, y: 37.5 }, 1000)).rejects.toBeInstanceOf(KakaoError);
  });

  it("category search paginates until is_end", async () => {
    process.env.KAKAO_REST_KEY = "k";
    const doc = (n: number) => ({ place_name: `역${n}`, category_name: "교통,수송 > 지하철,전철 > 수도권2호선", distance: String(n * 100), x: "127", y: "37.5" });
    const spy = vi
      .spyOn(axios, "get")
      .mockResolvedValueOnce({ status: 200, data: { meta: { total_count: 16, is_end: false }, documents: Array.from({ length: 15 }, (_, i) => doc(i)) } } as never)
      .mockResolvedValueOnce({ status: 200, data: { meta: { total_count: 16, is_end: true }, documents: [doc(15)] } } as never);
    const r = await categorySearch("SW8", { x: 127, y: 37.5 }, 1000);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][1]?.headers).toEqual({ Authorization: "KakaoAK k" });
    expect(r.places).toHaveLength(16);
    expect(r.places[15].distance_m).toBe(1500);
  });

  it("driving route uses future endpoint with departure_time", async () => {
    process.env.KAKAO_REST_KEY = "k";
    const spy = vi.spyOn(axios, "get").mockResolvedValue({
      status: 200,
      data: { routes: [{ result_code: 0, summary: { distance: 12345, duration: 1800, fare: { taxi: 15000, toll: 0 } } }] },
    } as never);
    const r = await drivingRoute({ x: 127, y: 37.5 }, { x: 127.1, y: 37.6 }, { departureTime: "202610210800" });
    expect(spy.mock.calls[0][0]).toContain("/v1/future/directions");
    expect(r.duration_sec).toBe(1800);
  });

  it("driving route surfaces route errors", async () => {
    process.env.KAKAO_REST_KEY = "k";
    vi.spyOn(axios, "get").mockResolvedValue({ status: 200, data: { routes: [{ result_code: 104, result_msg: "출발지와 도착지가 5m 이내" }] } } as never);
    await expect(drivingRoute({ x: 127, y: 37.5 }, { x: 127, y: 37.5 })).rejects.toThrow(/5m/);
  });

  it("normalizes departure time", () => {
    expect(normalizeDeparture("2026-10-21 08:00")).toBe("202610210800");
    expect(() => normalizeDeparture("내일 아침")).toThrow();
  });
});

describe("bus", () => {
  it("parses Seoul getStationByPos XML and route list", async () => {
    process.env.DATA_GO_KR_KEY = "k";
    const stations = `<ServiceResult><msgHeader><headerCd>0</headerCd><headerMsg>정상</headerMsg></msgHeader><msgBody>
      <itemList><arsId>05123</arsId><dist>210</dist><gpsX>127.08</gpsX><gpsY>37.53</gpsY><stationId>1</stationId><stationNm>자양동</stationNm></itemList>
      <itemList><arsId>05124</arsId><dist>90</dist><gpsX>127.081</gpsX><gpsY>37.531</gpsY><stationId>2</stationId><stationNm>건대입구</stationNm></itemList>
    </msgBody></ServiceResult>`;
    const routes = `<ServiceResult><msgHeader><headerCd>0</headerCd></msgHeader><msgBody><itemList><busRouteNm>2016</busRouteNm><busRouteType>4</busRouteType></itemList></msgBody></ServiceResult>`;
    vi.spyOn(axios, "get")
      .mockResolvedValueOnce({ status: 200, data: stations } as never)
      .mockResolvedValueOnce({ status: 200, data: routes } as never);
    const stops = await nearbyBusStops({ x: 127.08, y: 37.53 }, 500, true);
    expect(stops.map((s) => s.name)).toEqual(["건대입구", "자양동"]);
    const r = await routesForStop(stops[0]);
    expect(r).toEqual([{ no: "2016", type: "지선" }]);
  });

  it("Seoul headerCd 4 means no result", async () => {
    process.env.DATA_GO_KR_KEY = "k";
    vi.spyOn(axios, "get").mockResolvedValue({ status: 200, data: `<ServiceResult><msgHeader><headerCd>4</headerCd></msgHeader></ServiceResult>` } as never);
    expect(await nearbyBusStops({ x: 127, y: 37.5 }, 500, true)).toEqual([]);
  });

  it("TAGO stops are distance-filtered and sorted", async () => {
    process.env.DATA_GO_KR_KEY = "k";
    const body = {
      response: {
        header: { resultCode: "00" },
        body: {
          totalCount: 2,
          items: {
            item: [
              { citycode: 31020, nodeid: "GGB1", nodenm: "먼정류장", nodeno: 1, gpslati: 37.52, gpslong: 127.0 },
              { citycode: 31020, nodeid: "GGB2", nodenm: "가까운정류장", nodeno: 2, gpslati: 37.5005, gpslong: 127.0 },
            ],
          },
        },
      },
    };
    const spy = vi.spyOn(axios, "get").mockResolvedValue({ status: 200, data: JSON.stringify(body) } as never);
    const stops = await nearbyBusStops({ x: 127.0, y: 37.5 }, 500, false);
    expect(spy.mock.calls[0][1]?.params).toMatchObject({ _type: "json", gpsLati: 37.5, gpsLong: 127.0 });
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ name: "가까운정류장", city_code: "31020" });
  });
});
