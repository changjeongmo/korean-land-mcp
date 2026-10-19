import { resolveToPoint } from "../lib/resolve.js";
import { categorySearch, KAKAO_CATEGORIES, estimateWalkMin } from "../lib/kakao.js";

export interface FacilityArgs {
  query: string;
  categories?: string[];
  radius_m?: number;
  max_per_category?: number;
}

export const DEFAULT_FACILITY_CATEGORIES = ["학교", "어린이집·유치원", "대형마트", "병원", "공공기관", "은행"];

export const getNearbyFacilitiesTool = async (args: FacilityArgs) => {
  const radius = Math.min(Math.max(args.radius_m ?? 1000, 50), 20000);
  const maxPer = Math.min(Math.max(args.max_per_category ?? 10, 1), 45);
  const cats = (args.categories?.length ? args.categories : DEFAULT_FACILITY_CATEGORIES).slice(0, 10);

  const site = await resolveToPoint(args.query);
  const center = site.point_wgs84;

  const out: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const c of cats) {
    const cfg = KAKAO_CATEGORIES[c];
    if (!cfg) {
      errors[c] = `알 수 없는 카테고리. 사용 가능: ${Object.keys(KAKAO_CATEGORIES).join(", ")}`;
      continue;
    }
    try {
      const { places, total } = await categorySearch(cfg.code, center, radius, maxPer);
      out[c] = {
        total_in_radius: total,
        nearest_m: places[0]?.distance_m ?? null,
        items: places.map((p) => ({
          name: p.name,
          detail: p.category,
          straight_m: p.distance_m,
          est_walk_min: p.distance_m !== null ? estimateWalkMin(p.distance_m) : null,
          address: p.road_address || p.address,
        })),
      };
    } catch (e) {
      errors[c] = e instanceof Error ? e.message : String(e);
    }
  }

  const result = {
    query: args.query,
    site: { address: site.address, pnu: site.pnu, point_wgs84: center },
    radius_m: radius,
    facilities: out,
    errors,
    caveats: [
      "카카오 로컬 장소 데이터 기준이며, 폐업·이전이 늦게 반영될 수 있습니다.",
      "total_in_radius는 카카오가 집계한 반경 내 전체 건수이고, items는 가까운 순 상위 목록입니다.",
      "학교 배정(학군)은 교육청 통학구역 기준이므로 거리만으로 판단하지 마세요.",
    ],
  };
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
};
