import { resolveToPoint } from "../lib/resolve.js";
import { categorySearch, estimateWalkMin, KakaoPlace } from "../lib/kakao.js";
import { nearbyBusStops, routesForStop, BusStop } from "../lib/bus.js";

export interface TransitArgs {
  query: string;
  subway_radius_m?: number;
  bus_radius_m?: number;
  max_bus_stops_with_routes?: number;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? `${(e as { code?: string }).code ? (e as { code?: string }).code + ": " : ""}${e.message}` : String(e);
}

function lineOf(p: KakaoPlace): string {
  const parts = (p.category ?? "").split(">").map((s) => s.trim());
  return parts[parts.length - 1] || "";
}

function stationGrade(m: number | null): string {
  if (m === null) return "반경 내 역 없음";
  if (m <= 500) return "역세권 (직선 500m 이내, 도보 약 10분 이내)";
  if (m <= 1000) return "준역세권 (직선 500m~1km)";
  return "비역세권 (직선 1km 초과)";
}

export const getTransitAccessTool = async (args: TransitArgs) => {
  const subwayR = Math.min(Math.max(args.subway_radius_m ?? 1500, 100), 5000);
  const busR = Math.min(Math.max(args.bus_radius_m ?? 500, 100), 1500);
  const nRoutes = Math.min(Math.max(args.max_bus_stops_with_routes ?? 6, 0), 15);

  const site = await resolveToPoint(args.query);
  const center = site.point_wgs84;
  const isSeoul = (site.administrative.sido ?? "").includes("서울") || (site.pnu ?? "").startsWith("11");
  const errors: Record<string, string> = {};

  // 1) 지하철·전철역 (카카오 로컬 SW8)
  let stations: Array<Record<string, unknown>> = [];
  try {
    const { places } = await categorySearch("SW8", center, subwayR, 45);
    stations = places.map((p) => ({
      name: p.name,
      line: lineOf(p),
      straight_m: p.distance_m,
      est_walk_min: p.distance_m !== null ? estimateWalkMin(p.distance_m) : null,
      address: p.road_address || p.address,
      x: p.x,
      y: p.y,
    }));
  } catch (e) {
    errors.subway = errMsg(e);
  }
  const nearest = stations.length ? (stations[0].straight_m as number | null) : null;

  // 2) 버스정류장 + 경유노선
  let stops: BusStop[] = [];
  try {
    stops = await nearbyBusStops(center, busR, isSeoul);
    for (const s of stops.slice(0, nRoutes)) {
      try {
        s.routes = await routesForStop(s);
      } catch (e) {
        s.routes_error = errMsg(e);
      }
    }
  } catch (e) {
    errors.bus = errMsg(e);
  }

  const routeSet = new Map<string, string | null>();
  for (const s of stops) for (const r of s.routes ?? []) if (r.no) routeSet.set(r.no, r.type);
  const byType: Record<string, string[]> = {};
  for (const [no, type] of routeSet) (byType[type ?? "기타"] ??= []).push(no);
  for (const k of Object.keys(byType)) byType[k].sort((a, b) => a.localeCompare(b, "ko", { numeric: true }));

  const result = {
    query: args.query,
    site: { address: site.address, pnu: site.pnu, point_wgs84: center, region: site.administrative },
    subway: {
      radius_m: subwayR,
      count: stations.length,
      nearest_straight_m: nearest,
      grade: errors.subway ? "조회 실패" : stationGrade(nearest),
      stations,
    },
    bus: {
      radius_m: busR,
      source: isSeoul ? "서울특별시 정류소정보조회 (ws.bus.go.kr)" : "국토교통부 TAGO 버스정류소정보",
      stop_count: stops.length,
      unique_routes: routeSet.size,
      routes_by_type: byType,
      stops: stops.map((s) => ({
        name: s.name,
        stop_no: s.stop_no,
        distance_m: s.distance_m,
        est_walk_min: estimateWalkMin(s.distance_m),
        routes: s.routes?.map((r) => (r.type ? `${r.no}(${r.type})` : r.no)),
        routes_error: s.routes_error,
      })),
      note: nRoutes < stops.length ? `경유노선은 가까운 정류장 ${nRoutes}곳만 조회했습니다.` : undefined,
    },
    source_errors: errors,
    caveats: [
      "거리는 필지 중심점 기준 직선거리이고, 도보시간은 우회계수 1.3·보행속도 4km/h로 추정한 값입니다(실측 보행경로 아님).",
      "카카오 역 좌표는 역 대표점이며 출입구·승강장 기준이 아닙니다. 조례·사업지침상 역세권(승강장 경계 기준 반경 등)은 사업 유형별로 정의가 다르니 해당 기준으로 재확인하세요.",
      "환승역은 노선별로 따로 표시됩니다.",
    ],
  };

  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
};
