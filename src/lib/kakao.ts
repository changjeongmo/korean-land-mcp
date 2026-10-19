import axios from "axios";

/**
 * Kakao Developers REST API 클라이언트 (로컬 검색 + 카카오모빌리티 길찾기).
 * - 인증키: KAKAO_REST_KEY (developers.kakao.com → 내 애플리케이션 → 앱 키 → REST API 키)
 * - 카카오모빌리티 길찾기는 같은 REST API 키로 호출 (콘솔에서 '카카오내비' 사용 설정 필요할 수 있음)
 */

export class KakaoError extends Error {
  constructor(message: string, public readonly code?: string, public readonly meta?: unknown) {
    super(message);
    this.name = "KakaoError";
  }
}

function getKakaoKey(): string {
  const k = (process.env.KAKAO_REST_KEY || "").trim();
  if (!k || k === "your_kakao_rest_key_here") {
    throw new KakaoError(
      "KAKAO_REST_KEY is not configured. developers.kakao.com → 내 애플리케이션 → REST API 키를 환경변수에 넣으세요.",
      "NO_API_KEY"
    );
  }
  return k;
}

function authHeader() {
  return { Authorization: `KakaoAK ${getKakaoKey()}` };
}

/** 카카오 로컬 카테고리 그룹 코드 (한글 별칭 → 코드) */
export const KAKAO_CATEGORIES: Record<string, { code: string; label: string }> = {
  지하철역: { code: "SW8", label: "지하철역" },
  학교: { code: "SC4", label: "학교" },
  "어린이집·유치원": { code: "PS3", label: "어린이집·유치원" },
  학원: { code: "AC5", label: "학원" },
  대형마트: { code: "MT1", label: "대형마트" },
  편의점: { code: "CS2", label: "편의점" },
  병원: { code: "HP8", label: "병원" },
  약국: { code: "PM9", label: "약국" },
  은행: { code: "BK9", label: "은행" },
  공공기관: { code: "PO3", label: "공공기관" },
  문화시설: { code: "CT1", label: "문화시설" },
  관광명소: { code: "AT4", label: "관광명소" },
  숙박: { code: "AD5", label: "숙박" },
  음식점: { code: "FD6", label: "음식점" },
  카페: { code: "CE7", label: "카페" },
  주차장: { code: "PK6", label: "주차장" },
  주유소: { code: "OL7", label: "주유소·충전소" },
  중개업소: { code: "AG2", label: "중개업소" },
};

export interface KakaoPlace {
  name: string;
  category: string;
  category_group: string;
  address: string;
  road_address: string;
  phone: string;
  distance_m: number | null;
  x: number;
  y: number;
  url: string;
}

function toPlace(d: any): KakaoPlace {
  return {
    name: d.place_name,
    category: d.category_name,
    category_group: d.category_group_name,
    address: d.address_name,
    road_address: d.road_address_name,
    phone: d.phone,
    distance_m: d.distance !== undefined && d.distance !== "" ? Number(d.distance) : null,
    x: Number(d.x),
    y: Number(d.y),
    url: d.place_url,
  };
}

async function kakaoGet(url: string, params: Record<string, string | number>) {
  const res = await axios.get(url, {
    params,
    headers: authHeader(),
    timeout: 10_000,
    validateStatus: () => true,
  });
  if (res.status >= 400) {
    const msg = res.data?.message || res.data?.msg || `HTTP ${res.status}`;
    throw new KakaoError(`Kakao ${url.split("/").slice(-2).join("/")}: ${msg}`, `HTTP_${res.status}`, res.data);
  }
  return res.data;
}

/** 좌표 반경 내 카테고리 검색. 카카오 제한: 페이지당 15건, 최대 3페이지(45건), 반경 최대 20km */
export async function categorySearch(
  code: string,
  center: { x: number; y: number },
  radiusM: number,
  maxResults = 45
): Promise<{ places: KakaoPlace[]; total: number }> {
  const places: KakaoPlace[] = [];
  let total = 0;
  for (let page = 1; page <= 3 && places.length < maxResults; page++) {
    const data = await kakaoGet("https://dapi.kakao.com/v2/local/search/category.json", {
      category_group_code: code,
      x: center.x,
      y: center.y,
      radius: Math.min(20000, Math.max(1, Math.round(radiusM))),
      sort: "distance",
      page,
      size: 15,
    });
    total = data?.meta?.total_count ?? total;
    places.push(...(data?.documents ?? []).map(toPlace));
    if (data?.meta?.is_end) break;
  }
  return { places: places.slice(0, maxResults), total };
}

/** 키워드(장소명) 검색 → 최상위 1건. center가 있으면 거리순 */
export async function keywordSearchFirst(
  query: string,
  center?: { x: number; y: number }
): Promise<KakaoPlace | null> {
  const params: Record<string, string | number> = { query, size: 1 };
  if (center) {
    params.x = center.x;
    params.y = center.y;
  }
  const data = await kakaoGet("https://dapi.kakao.com/v2/local/search/keyword.json", params);
  const d = data?.documents?.[0];
  return d ? toPlace(d) : null;
}

/** 주소 검색 → 좌표 */
export async function addressSearchFirst(query: string): Promise<{ x: number; y: number; address: string } | null> {
  const data = await kakaoGet("https://dapi.kakao.com/v2/local/search/address.json", { query, size: 1 });
  const d = data?.documents?.[0];
  return d ? { x: Number(d.x), y: Number(d.y), address: d.address_name } : null;
}

export interface DriveResult {
  distance_m: number;
  duration_sec: number;
  taxi_fare_won: number | null;
  toll_won: number | null;
}

/**
 * 카카오모빌리티 자동차 길찾기. departureTime(YYYYMMDDHHmm) 지정 시 미래 운행정보(예측 교통) 사용.
 */
export async function drivingRoute(
  origin: { x: number; y: number },
  dest: { x: number; y: number },
  opts: { priority?: "RECOMMEND" | "TIME" | "DISTANCE"; departureTime?: string } = {}
): Promise<DriveResult> {
  const base = opts.departureTime
    ? "https://apis-navi.kakaomobility.com/v1/future/directions"
    : "https://apis-navi.kakaomobility.com/v1/directions";
  const params: Record<string, string | number> = {
    origin: `${origin.x},${origin.y}`,
    destination: `${dest.x},${dest.y}`,
    priority: opts.priority ?? "RECOMMEND",
    summary: "true",
  };
  if (opts.departureTime) params.departure_time = opts.departureTime;
  const data = await kakaoGet(base, params);
  const route = data?.routes?.[0];
  if (!route || route.result_code !== 0) {
    throw new KakaoError(
      `길찾기 실패: ${route?.result_msg ?? "결과 없음"}`,
      `ROUTE_${route?.result_code ?? "NONE"}`,
      route
    );
  }
  const s = route.summary;
  return {
    distance_m: s.distance,
    duration_sec: s.duration,
    taxi_fare_won: s.fare?.taxi ?? null,
    toll_won: s.fare?.toll ?? null,
  };
}

/** 두 WGS84 좌표 간 직선거리(m) */
export function haversineM(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const R = 6371008.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.y - a.y);
  const dLon = toRad(b.x - a.x);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.y)) * Math.cos(toRad(b.y)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * 직선거리 → 도보시간 추정(분). 도로 우회계수 1.3, 보행속도 4km/h(≈66.7m/분).
 * 실제 보행경로가 아닌 추정치임을 결과에 명시할 것.
 */
export function estimateWalkMin(straightM: number): number {
  return Math.round((straightM * 1.3) / 66.7);
}
