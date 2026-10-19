import { Row, num, pick } from "./datagokr.js";

/**
 * 국토교통부 실거래가 공개시스템(RTMS) API 설정·정규화·통계.
 * 2024년 이후 apis.data.go.kr/1613000 체계(영문 필드명) 기준이며,
 * 과거 한글 필드명도 함께 인식하도록 후보 키를 둔다.
 */

const BASE = "https://apis.data.go.kr/1613000";
export const PYEONG_M2 = 3.305785;

export type PropertyType = "아파트" | "오피스텔" | "연립다세대" | "단독다가구" | "상업업무용" | "토지" | "공장창고" | "분양권";
export type DealKind = "매매" | "전월세";

interface TypeConfig {
  trade: string;
  rent?: string;
  /** 단가 계산 기준 면적 */
  areaKeys: string[];
  areaBasis: string;
  landAreaKeys?: string[];
  nameKeys?: string[];
}

export const PROPERTY_TYPES: Record<PropertyType, TypeConfig> = {
  아파트: {
    trade: "RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade",
    rent: "RTMSDataSvcAptRent/getRTMSDataSvcAptRent",
    areaKeys: ["excluUseAr", "전용면적"],
    areaBasis: "전용면적",
    nameKeys: ["aptNm", "아파트"],
  },
  오피스텔: {
    trade: "RTMSDataSvcOffiTrade/getRTMSDataSvcOffiTrade",
    rent: "RTMSDataSvcOffiRent/getRTMSDataSvcOffiRent",
    areaKeys: ["excluUseAr", "전용면적"],
    areaBasis: "전용면적",
    nameKeys: ["offiNm", "단지", "단지명"],
  },
  연립다세대: {
    trade: "RTMSDataSvcRHTrade/getRTMSDataSvcRHTrade",
    rent: "RTMSDataSvcRHRent/getRTMSDataSvcRHRent",
    areaKeys: ["excluUseAr", "전용면적"],
    areaBasis: "전용면적",
    landAreaKeys: ["landAr", "대지권면적"],
    nameKeys: ["mhouseNm", "연립다세대"],
  },
  단독다가구: {
    trade: "RTMSDataSvcSHTrade/getRTMSDataSvcSHTrade",
    rent: "RTMSDataSvcSHRent/getRTMSDataSvcSHRent",
    areaKeys: ["totalFloorAr", "연면적"],
    areaBasis: "연면적",
    landAreaKeys: ["plottageAr", "대지면적"],
  },
  상업업무용: {
    trade: "RTMSDataSvcNrgTrade/getRTMSDataSvcNrgTrade",
    areaKeys: ["buildingAr", "건물면적"],
    areaBasis: "건물면적",
    landAreaKeys: ["plottageAr", "대지면적"],
  },
  토지: {
    trade: "RTMSDataSvcLandTrade/getRTMSDataSvcLandTrade",
    areaKeys: ["dealArea", "거래면적"],
    areaBasis: "토지 거래면적",
  },
  공장창고: {
    trade: "RTMSDataSvcInduTrade/getRTMSDataSvcInduTrade",
    areaKeys: ["buildingAr", "건물면적"],
    areaBasis: "건물면적",
    landAreaKeys: ["plottageAr", "대지면적"],
  },
  분양권: {
    trade: "RTMSDataSvcSilvTrade/getRTMSDataSvcSilvTrade",
    areaKeys: ["excluUseAr", "전용면적"],
    areaBasis: "전용면적",
    nameKeys: ["aptNm", "단지"],
  },
};

export function endpointFor(type: PropertyType, kind: DealKind): string {
  const cfg = PROPERTY_TYPES[type];
  const path = kind === "매매" ? cfg.trade : cfg.rent;
  if (!path) throw new Error(`${type}은(는) 전월세 실거래 API가 없습니다 (매매만 제공).`);
  return `${BASE}/${path}`;
}

export interface Deal {
  date: string | null; // YYYY-MM-DD
  ym: string | null; // YYYYMM
  dong: string | null;
  jibun: string | null;
  name: string | null;
  building_use: string | null;
  zoning: string | null;
  jimok: string | null;
  floor: string | null;
  build_year: number | null;
  area_m2: number | null;
  land_area_m2: number | null;
  /** 매매: 거래금액(만원) */
  price_manwon: number | null;
  /** 전월세 */
  deposit_manwon: number | null;
  monthly_rent_manwon: number | null;
  /** 매매가 또는 보증금 ÷ 기준면적 */
  unit_manwon_per_m2: number | null;
  unit_manwon_per_pyeong: number | null;
  land_unit_manwon_per_pyeong: number | null;
  deal_method: string | null; // 중개거래/직거래
  canceled: boolean;
  share_deal: boolean;
  contract_type: string | null; // 신규/갱신 (전월세)
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export function normalizeDeal(row: Row, type: PropertyType, kind: DealKind): Deal {
  const cfg = PROPERTY_TYPES[type];
  const y = pick(row, ["dealYear", "년"]);
  const m = pick(row, ["dealMonth", "월"]);
  const d = pick(row, ["dealDay", "일"]);
  const mm = m ? m.padStart(2, "0") : null;
  const date = y && mm && d ? `${y}-${mm}-${d.padStart(2, "0")}` : null;

  const area = num(pick(row, cfg.areaKeys));
  const landArea = cfg.landAreaKeys ? num(pick(row, cfg.landAreaKeys)) : null;
  const price = kind === "매매" ? num(pick(row, ["dealAmount", "거래금액"])) : null;
  const deposit = kind === "전월세" ? num(pick(row, ["deposit", "보증금액", "보증금"])) : null;
  const monthly = kind === "전월세" ? num(pick(row, ["monthlyRent", "월세금액", "월세"])) : null;
  const basis = kind === "매매" ? price : deposit;

  const unitM2 = basis !== null && area ? basis / area : null;
  const landUnit = price !== null && landArea ? (price / landArea) * PYEONG_M2 : null;

  const cancelFlag = pick(row, ["cdealType", "해제여부"]);
  const share = pick(row, ["shareDealingType", "지분거래구분", "dealingType"]);

  return {
    date,
    ym: y && mm ? `${y}${mm}` : null,
    dong: pick(row, ["umdNm", "법정동"]) ?? null,
    jibun: pick(row, ["jibun", "지번"]) ?? null,
    name: cfg.nameKeys ? pick(row, cfg.nameKeys) ?? null : null,
    building_use: pick(row, ["buildingUse", "건물주용도", "houseType", "주택유형", "buildingType"]) ?? null,
    zoning: pick(row, ["landUse", "용도지역"]) ?? null,
    jimok: pick(row, ["jimok", "지목"]) ?? null,
    floor: pick(row, ["floor", "층"]) ?? null,
    build_year: num(pick(row, ["buildYear", "건축년도"])),
    area_m2: area,
    land_area_m2: landArea,
    price_manwon: price,
    deposit_manwon: deposit,
    monthly_rent_manwon: monthly,
    unit_manwon_per_m2: unitM2 !== null ? r1(unitM2) : null,
    unit_manwon_per_pyeong: unitM2 !== null ? r1(unitM2 * PYEONG_M2) : null,
    land_unit_manwon_per_pyeong: landUnit !== null ? r1(landUnit) : null,
    deal_method: pick(row, ["dealingGbn", "거래유형"]) ?? null,
    canceled: !!cancelFlag && /^(o|y|해제)/i.test(cancelFlag.trim()),
    share_deal: !!share && /지분/.test(share),
    contract_type: pick(row, ["contractType", "계약구분"]) ?? null,
  };
}

export interface Stat {
  count: number;
  min: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  max: number | null;
  mean: number | null;
}

export function describe(values: (number | null)[]): Stat {
  const v = values.filter((x): x is number => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) return { count: 0, min: null, p25: null, median: null, p75: null, max: null, mean: null };
  const q = (p: number) => {
    const idx = (n - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return r1(v[lo] + (v[hi] - v[lo]) * (idx - lo));
  };
  return {
    count: n,
    min: v[0],
    p25: q(0.25),
    median: q(0.5),
    p75: q(0.75),
    max: v[n - 1],
    mean: r1(v.reduce((a, b) => a + b, 0) / n),
  };
}

/** YYYYMM 목록 (from..to 포함) */
export function monthRange(fromYm: string, toYm: string): string[] {
  const parse = (s: string) => ({ y: parseInt(s.slice(0, 4), 10), m: parseInt(s.slice(4, 6), 10) });
  const a = parse(fromYm);
  const b = parse(toYm);
  if (!a.y || !a.m || !b.y || !b.m || a.m > 12 || b.m > 12) throw new Error(`잘못된 기간: ${fromYm}~${toYm} (YYYYMM)`);
  const out: string[] = [];
  let y = a.y;
  let m = a.m;
  while (y < b.y || (y === b.y && m <= b.m)) {
    out.push(`${y}${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

export function shiftYm(ym: string, deltaMonths: number): string {
  const y = parseInt(ym.slice(0, 4), 10);
  const m = parseInt(ym.slice(4, 6), 10) - 1 + deltaMonths;
  const ny = y + Math.floor(m / 12);
  const nm = ((m % 12) + 12) % 12;
  return `${ny}${String(nm + 1).padStart(2, "0")}`;
}

export function currentYmKst(now = new Date()): string {
  const kst = new Date(now.getTime() + 9 * 3600_000);
  return `${kst.getUTCFullYear()}${String(kst.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** 매매 요약 (가격·단가 분포, 월별 추이, 단지/용도별 상위) */
export function summarizeTrades(deals: Deal[]) {
  const byMonth = new Map<string, Deal[]>();
  for (const d of deals) {
    if (!d.ym) continue;
    byMonth.set(d.ym, [...(byMonth.get(d.ym) ?? []), d]);
  }
  const monthly = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ym, list]) => ({
      ym,
      count: list.length,
      median_price_manwon: describe(list.map((d) => d.price_manwon)).median,
      median_unit_manwon_per_pyeong: describe(list.map((d) => d.unit_manwon_per_pyeong)).median,
    }));

  const groupKey = (d: Deal) => d.name ?? d.building_use ?? d.zoning ?? d.jimok ?? "(미상)";
  const groups = new Map<string, Deal[]>();
  for (const d of deals) groups.set(groupKey(d), [...(groups.get(groupKey(d)) ?? []), d]);
  const top_groups = [...groups.entries()]
    .map(([key, list]) => ({
      key,
      count: list.length,
      median_unit_manwon_per_pyeong: describe(list.map((d) => d.unit_manwon_per_pyeong)).median,
      median_price_manwon: describe(list.map((d) => d.price_manwon)).median,
      latest_date: list.map((d) => d.date ?? "").sort().at(-1) || null,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  return {
    price_manwon: describe(deals.map((d) => d.price_manwon)),
    unit_manwon_per_pyeong: describe(deals.map((d) => d.unit_manwon_per_pyeong)),
    land_unit_manwon_per_pyeong: describe(deals.map((d) => d.land_unit_manwon_per_pyeong)),
    monthly,
    top_groups,
  };
}

/** 전월세 요약: 전세(월세 0)와 월세 분리 */
export function summarizeRents(deals: Deal[]) {
  const jeonse = deals.filter((d) => (d.monthly_rent_manwon ?? 0) === 0);
  const wolse = deals.filter((d) => (d.monthly_rent_manwon ?? 0) > 0);
  return {
    jeonse: {
      count: jeonse.length,
      deposit_manwon: describe(jeonse.map((d) => d.deposit_manwon)),
      deposit_manwon_per_pyeong: describe(jeonse.map((d) => d.unit_manwon_per_pyeong)),
    },
    wolse: {
      count: wolse.length,
      deposit_manwon: describe(wolse.map((d) => d.deposit_manwon)),
      monthly_rent_manwon: describe(wolse.map((d) => d.monthly_rent_manwon)),
      monthly_rent_manwon_per_pyeong: describe(
        wolse.map((d) => (d.monthly_rent_manwon !== null && d.area_m2 ? r1((d.monthly_rent_manwon / d.area_m2) * PYEONG_M2) : null))
      ),
    },
    new_vs_renewal: {
      신규: deals.filter((d) => d.contract_type === "신규").length,
      갱신: deals.filter((d) => d.contract_type === "갱신").length,
    },
  };
}
