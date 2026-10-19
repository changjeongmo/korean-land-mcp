import axios from "axios";
import { XMLParser } from "fast-xml-parser";
import { fetchAllPages, getDataGoKrKey, DataGoKrError } from "./datagokr.js";
import { haversineM } from "./kakao.js";

/**
 * 버스정류장·경유노선 조회.
 * - 서울: 서울특별시 정류소정보조회 서비스 (ws.bus.go.kr, data.go.kr 동일 인증키, 별도 활용신청)
 * - 서울 외: 국토교통부 TAGO 버스정류소정보 (apis.data.go.kr/1613000/BusSttnInfoInqireService)
 */

export interface BusStop {
  source: "seoul" | "tago";
  name: string;
  stop_no: string | null; // 서울 arsId / TAGO nodeno
  id: string;
  city_code: string | null;
  x: number;
  y: number;
  distance_m: number;
  routes?: BusRoute[];
  routes_error?: string;
}

export interface BusRoute {
  no: string;
  type: string | null;
  start?: string | null;
  end?: string | null;
}

const TAGO = "https://apis.data.go.kr/1613000/BusSttnInfoInqireService";
const SEOUL = "http://ws.bus.go.kr/api/rest/stationinfo";

const xml = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true });

const SEOUL_ROUTE_TYPE: Record<string, string> = {
  "0": "공용",
  "1": "공항",
  "2": "마을",
  "3": "간선",
  "4": "지선",
  "5": "순환",
  "6": "광역",
  "7": "인천",
  "8": "경기",
  "9": "폐지",
};

async function seoulGet(op: string, params: Record<string, string | number>): Promise<Record<string, string>[]> {
  const res = await axios.get(`${SEOUL}/${op}`, {
    params: { serviceKey: getDataGoKrKey(), ...params },
    timeout: 10_000,
    responseType: "text",
    validateStatus: () => true,
  });
  if (res.status >= 400) throw new DataGoKrError(`서울 버스 ${op}: HTTP ${res.status}`, `HTTP_${res.status}`);
  const doc = xml.parse(String(res.data));
  const gw = doc?.OpenAPI_ServiceResponse?.cmmMsgHeader;
  if (gw) throw new DataGoKrError(`서울 버스 ${op}: ${gw.returnAuthMsg || gw.errMsg}`, String(gw.returnAuthMsg || "GATEWAY_ERROR"));
  const root = doc?.ServiceResult;
  const code = String(root?.msgHeader?.headerCd ?? "");
  if (code === "4") return []; // 결과 없음
  if (code !== "0") throw new DataGoKrError(`서울 버스 ${op}: ${root?.msgHeader?.headerMsg ?? "응답 오류"} (headerCd ${code})`, `SEOUL_${code}`);
  const list = root?.msgBody?.itemList;
  if (!list) return [];
  return (Array.isArray(list) ? list : [list]).map((o: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v == null ? "" : String(v)]))
  );
}

export async function nearbyBusStops(
  center: { x: number; y: number },
  radiusM: number,
  isSeoul: boolean
): Promise<BusStop[]> {
  if (isSeoul) {
    const rows = await seoulGet("getStationByPos", { tmX: center.x, tmY: center.y, radius: Math.min(1500, Math.round(radiusM)) });
    return rows
      .map((r) => {
        const x = Number(r.gpsX);
        const y = Number(r.gpsY);
        return {
          source: "seoul" as const,
          name: r.stationNm,
          stop_no: r.arsId || null,
          id: r.stationId,
          city_code: null,
          x,
          y,
          distance_m: Math.round(r.dist ? Number(r.dist) : haversineM(center, { x, y })),
        };
      })
      .sort((a, b) => a.distance_m - b.distance_m);
  }

  const { items } = await fetchAllPages(
    `${TAGO}/getCrdntPrxmtSttnList`,
    { gpsLati: center.y, gpsLong: center.x },
    { label: "TAGO 좌표기반 근접정류소", pageSize: 100, maxRows: 300, json: true }
  );
  return items
    .map((r) => {
      const x = Number(r.gpslong);
      const y = Number(r.gpslati);
      return {
        source: "tago" as const,
        name: r.nodenm,
        stop_no: r.nodeno || null,
        id: r.nodeid,
        city_code: r.citycode || null,
        x,
        y,
        distance_m: Math.round(haversineM(center, { x, y })),
      };
    })
    .filter((s) => s.distance_m <= radiusM)
    .sort((a, b) => a.distance_m - b.distance_m);
}

export async function routesForStop(stop: BusStop): Promise<BusRoute[]> {
  if (stop.source === "seoul") {
    if (!stop.stop_no) return [];
    const rows = await seoulGet("getRouteByStation", { arsId: stop.stop_no });
    return rows.map((r) => ({
      no: r.busRouteNm || r.busRouteAbrv,
      type: SEOUL_ROUTE_TYPE[r.busRouteType] ?? (r.busRouteType || null),
    }));
  }
  const { items } = await fetchAllPages(
    `${TAGO}/getSttnThrghRouteList`,
    { cityCode: stop.city_code ?? "", nodeid: stop.id },
    { label: `TAGO 경유노선 ${stop.name}`, pageSize: 100, maxRows: 200, json: true }
  );
  return items.map((r) => ({
    no: r.routeno,
    type: r.routetp || null,
    start: r.startnodenm || null,
    end: r.endnodenm || null,
  }));
}
