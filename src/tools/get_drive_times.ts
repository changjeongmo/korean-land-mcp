import { resolveToPoint } from "../lib/resolve.js";
import { keywordSearchFirst, addressSearchFirst, drivingRoute, haversineM } from "../lib/kakao.js";

export interface DriveArgs {
  query: string;
  destinations: string[];
  departure_time?: string;
  priority?: "RECOMMEND" | "TIME" | "DISTANCE";
}

function errMsg(e: unknown): string {
  const code = (e as { code?: string })?.code;
  return e instanceof Error ? `${code ? code + ": " : ""}${e.message}` : String(e);
}

/** "2026-10-20 08:00" | "202610200800" → "202610200800" */
export function normalizeDeparture(s?: string): string | undefined {
  if (!s) return undefined;
  const digits = s.replace(/\D/g, "");
  if (!/^\d{12}$/.test(digits)) throw new Error(`departure_time 형식 오류: '${s}' (예: 2026-10-20 08:00)`);
  return digits;
}

export const getDriveTimesTool = async (args: DriveArgs) => {
  const site = await resolveToPoint(args.query);
  const origin = site.point_wgs84;
  const departure = normalizeDeparture(args.departure_time);

  const rows = [];
  for (const dest of args.destinations.slice(0, 10)) {
    try {
      const place = await keywordSearchFirst(dest);
      const target = place
        ? { x: place.x, y: place.y, label: place.name, address: place.road_address || place.address }
        : await addressSearchFirst(dest).then((a) => (a ? { x: a.x, y: a.y, label: dest, address: a.address } : null));
      if (!target) {
        rows.push({ destination: dest, error: "목적지를 찾지 못했습니다" });
        continue;
      }
      const r = await drivingRoute(origin, target, { priority: args.priority, departureTime: departure });
      rows.push({
        destination: dest,
        matched: target.label,
        matched_address: target.address,
        drive_min: Math.round(r.duration_sec / 60),
        drive_km: Math.round(r.distance_m / 100) / 10,
        straight_km: Math.round(haversineM(origin, target) / 100) / 10,
        toll_won: r.toll_won,
        taxi_fare_won: r.taxi_fare_won,
      });
    } catch (e) {
      rows.push({ destination: dest, error: errMsg(e) });
    }
  }

  const result = {
    query: args.query,
    origin: { address: site.address, pnu: site.pnu, point_wgs84: origin },
    basis: departure
      ? `카카오모빌리티 미래 운행정보 — 출발 ${departure.slice(0, 4)}-${departure.slice(4, 6)}-${departure.slice(6, 8)} ${departure.slice(8, 10)}:${departure.slice(10, 12)} 예측 교통`
      : "카카오모빌리티 길찾기 — 조회 시점 실시간 교통",
    priority: args.priority ?? "RECOMMEND",
    results: rows,
    caveats: [
      "목적지는 카카오 장소검색 1순위 결과로 매칭됩니다. matched 값이 의도한 곳인지 확인하세요.",
      "실시간 결과는 조회 시각의 교통상황에 좌우됩니다. 보고서에는 departure_time으로 출퇴근 시간대(예: 평일 08:00)를 지정한 값을 쓰는 것이 일관적입니다.",
    ],
  };
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
};
