import { resolveToPoint } from "../lib/resolve.js";
import { fetchAllPages, DataGoKrError, Row } from "../lib/datagokr.js";
import {
  PropertyType,
  DealKind,
  PROPERTY_TYPES,
  endpointFor,
  normalizeDeal,
  monthRange,
  shiftYm,
  currentYmKst,
  summarizeTrades,
  summarizeRents,
  Deal,
} from "../lib/rtms.js";

export interface RealTxArgs {
  region: string;
  property_type: PropertyType;
  deal_kind?: DealKind;
  from_ym?: string;
  to_ym?: string;
  scope?: "dong" | "sigungu";
  dong?: string;
  name_contains?: string;
  min_area_m2?: number;
  max_area_m2?: number;
  include_canceled?: boolean;
  max_list?: number;
}

/** region → 시군구코드(LAWD_CD 5자리) + (선택) 읍면동명 */
export async function resolveRegion(region: string): Promise<{ lawd_cd: string; dong: string | null; label: string; via: string }> {
  const s = region.trim();
  if (/^\d{5}$/.test(s)) return { lawd_cd: s, dong: null, label: s, via: "LAWD_CD 직접 입력" };
  if (/^\d{10}$/.test(s) || /^\d{19}$/.test(s)) {
    if (/^\d{19}$/.test(s)) {
      const r = await resolveToPoint(s);
      return { lawd_cd: s.slice(0, 5), dong: r.administrative.emd_dong ?? null, label: r.address ?? s, via: "PNU" };
    }
    return { lawd_cd: s.slice(0, 5), dong: null, label: s, via: "법정동코드 앞 5자리" };
  }
  const r = await resolveToPoint(s);
  const code = r.pnu?.slice(0, 5) ?? r.administrative.emd_dong_code?.slice(0, 5);
  if (!code || !/^\d{5}$/.test(code)) {
    throw new DataGoKrError(`'${region}'의 시군구코드를 찾지 못했습니다. 지번 주소나 5자리 시군구코드를 넣어주세요.`, "REGION_NOT_FOUND");
  }
  return {
    lawd_cd: code,
    dong: r.administrative.emd_dong ?? null,
    label: [r.administrative.sido, r.administrative.sigg, r.administrative.emd_dong].filter(Boolean).join(" ") || r.address || s,
    via: "V-World 지오코딩 → PNU 앞 5자리",
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

export const getRealTransactionsTool = async (args: RealTxArgs) => {
  const kind: DealKind = args.deal_kind ?? "매매";
  const url = endpointFor(args.property_type, kind);

  const toYm = args.to_ym ?? currentYmKst();
  const fromYm = args.from_ym ?? shiftYm(toYm, -11);
  const months = monthRange(fromYm, toYm);
  if (months.length > 36) throw new Error(`기간이 ${months.length}개월입니다. 최대 36개월까지 조회합니다.`);

  const region = await resolveRegion(args.region);
  const scope = args.scope ?? (region.dong ? "dong" : "sigungu");
  const dongFilter = args.dong ?? (scope === "dong" ? region.dong : null);

  const monthErrors: { ym: string; error: string }[] = [];
  const monthRows = await mapLimit(months, 4, async (ym) => {
    try {
      const r = await fetchAllPages(url, { LAWD_CD: region.lawd_cd, DEAL_YMD: ym }, { label: `${args.property_type} ${kind} ${ym}` });
      return r.items;
    } catch (e) {
      // 인증키 오류는 모든 월에 동일하므로 즉시 중단
      if (e instanceof DataGoKrError && /KEY|ACCESS_DENIED|RESULT_(20|22|30|31|32)$/i.test(e.code ?? "")) throw e;
      monthErrors.push({ ym, error: e instanceof Error ? e.message : String(e) });
      return [] as Row[];
    }
  });

  const allDeals = monthRows.flat().map((row) => normalizeDeal(row, args.property_type, kind));
  const sigunguTotal = allDeals.length;

  let deals: Deal[] = allDeals;
  if (!args.include_canceled) deals = deals.filter((d) => !d.canceled);
  let dongApplied: string | null = null;
  let dongFallbackNote: string | null = null;
  if (dongFilter) {
    const filtered = deals.filter((d) => (d.dong ?? "").includes(dongFilter));
    if (filtered.length === 0 && !args.dong) {
      dongFallbackNote = `'${dongFilter}' 거래가 기간 내 0건이라 시군구 전체로 집계했습니다.`;
    } else {
      deals = filtered;
      dongApplied = dongFilter;
    }
  }
  if (args.name_contains) deals = deals.filter((d) => (d.name ?? "").includes(args.name_contains!));
  if (args.min_area_m2 !== undefined) deals = deals.filter((d) => (d.area_m2 ?? -1) >= args.min_area_m2!);
  if (args.max_area_m2 !== undefined) deals = deals.filter((d) => (d.area_m2 ?? Infinity) <= args.max_area_m2!);

  deals.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  const maxList = Math.min(args.max_list ?? 30, 200);

  const result = {
    query: args,
    region: {
      lawd_cd: region.lawd_cd,
      label: region.label,
      resolved_via: region.via,
      dong_filter: dongApplied,
      note: dongFallbackNote,
    },
    period: { from_ym: fromYm, to_ym: toYm, months: months.length },
    property_type: args.property_type,
    deal_kind: kind,
    counts: {
      sigungu_rows: sigunguTotal,
      after_filters: deals.length,
      canceled_excluded: args.include_canceled ? 0 : allDeals.filter((d) => d.canceled).length,
    },
    units: {
      price: "만원",
      unit_price: `만원/평 (기준면적: ${PROPERTY_TYPES[args.property_type].areaBasis})`,
      area: "㎡ (1평 = 3.305785㎡)",
    },
    summary: kind === "매매" ? summarizeTrades(deals) : summarizeRents(deals),
    recent_deals: deals.slice(0, maxList),
    month_errors: monthErrors,
    caveats: [
      "국토교통부 실거래가 공개자료 기준. 신고기한(계약 후 30일) 때문에 최근 1~2개월은 건수가 덜 집계됩니다.",
      "상업업무용·토지·공장창고는 개인정보 보호로 지번이 일부 가려져(예: '1**') 필지 단위 특정이 어렵습니다.",
      "지분거래(share_deal=true)는 단가가 왜곡되므로 비교사례에서 제외를 검토하세요.",
      "단가는 매매가(전월세는 보증금) ÷ 기준면적으로 계산한 값입니다. 감정평가 시 시점·지역·개별요인 보정이 필요합니다.",
    ],
    source: `국토교통부 실거래가 (apis.data.go.kr/1613000) — ${url.split("/").slice(-2, -1)[0]}`,
  };

  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
};
