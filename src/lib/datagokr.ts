import axios from "axios";
import { XMLParser } from "fast-xml-parser";

/**
 * 공공데이터포털(apis.data.go.kr) 공통 클라이언트.
 * - 인증키: DATA_GO_KR_KEY (일반 인증키 Decoding 값 권장. Encoding 값을 넣어도 자동 복원)
 * - XML/JSON 응답 모두 처리, 페이지 자동 순회, 오류 코드를 정직하게 노출 (가짜 데이터 없음)
 */

export class DataGoKrError extends Error {
  constructor(message: string, public readonly code?: string, public readonly meta?: unknown) {
    super(message);
    this.name = "DataGoKrError";
  }
}

export function getDataGoKrKey(): string {
  const raw = (process.env.DATA_GO_KR_KEY || "").trim();
  if (!raw || raw === "your_data_gov_key_here") {
    throw new DataGoKrError(
      "DATA_GO_KR_KEY is not configured. data.go.kr 마이페이지 → 일반 인증키(Decoding)를 환경변수에 넣으세요.",
      "NO_API_KEY"
    );
  }
  // Encoding 키(%2B, %3D …)가 들어오면 axios가 한 번 더 인코딩하지 않도록 복원
  if (/%[0-9A-Fa-f]{2}/.test(raw)) {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

const xml = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false, // 숫자 변환은 직접 (거래금액 "12,500" 등)
  trimValues: true,
});

const OK_CODES = new Set(["00", "000", "0", "INFO-000", "NORMAL_CODE", "NORMAL SERVICE."]);

export type Row = Record<string, string>;

export interface PageResult {
  items: Row[];
  totalCount: number;
}

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null || (v as unknown) === "") return [];
  return Array.isArray(v) ? v : [v];
}

function stringifyRow(o: Record<string, unknown>): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(o ?? {})) {
    out[k] = v === null || v === undefined ? "" : String(v).trim();
  }
  return out;
}

/** XML 또는 JSON 응답 본문 → { items, totalCount }. 오류 응답이면 DataGoKrError. */
export function parseDataGoKrBody(body: unknown, label: string): PageResult {
  let doc: any = body;
  if (typeof body === "string") {
    const s = body.trim();
    if (s.startsWith("{")) {
      try {
        doc = JSON.parse(s);
      } catch {
        throw new DataGoKrError(`${label}: JSON 파싱 실패`, "PARSE_FAILED", s.slice(0, 300));
      }
    } else if (s.startsWith("<")) {
      doc = xml.parse(s);
    } else {
      throw new DataGoKrError(`${label}: 알 수 없는 응답 — ${s.slice(0, 200)}`, "UNKNOWN_BODY");
    }
  }

  // 게이트웨이 인증 오류 (예: SERVICE_KEY_IS_NOT_REGISTERED_ERROR)
  const gw = doc?.OpenAPI_ServiceResponse?.cmmMsgHeader;
  if (gw) {
    throw new DataGoKrError(
      `${label}: ${gw.returnAuthMsg || gw.errMsg || "gateway error"} (reasonCode ${gw.returnReasonCode ?? "?"})`,
      String(gw.returnAuthMsg || "GATEWAY_ERROR"),
      gw
    );
  }

  const resp = doc?.response ?? doc;
  const header = resp?.header ?? {};
  const code = header.resultCode !== undefined ? String(header.resultCode) : undefined;
  if (code !== undefined && !OK_CODES.has(code)) {
    throw new DataGoKrError(`${label}: ${header.resultMsg || "error"} (resultCode ${code})`, `RESULT_${code}`, header);
  }

  const bodyNode = resp?.body ?? {};
  const totalCount = parseInt(String(bodyNode.totalCount ?? "0"), 10) || 0;
  const itemsNode = bodyNode.items;
  const rawItems = itemsNode && typeof itemsNode === "object" ? asArray(itemsNode.item) : [];
  return { items: rawItems.map((r: any) => stringifyRow(r)), totalCount };
}

const BACKOFF_MS = [400, 1200];

/** 단일 엔드포인트를 페이지 끝까지 조회 (maxRows 상한). */
export async function fetchAllPages(
  url: string,
  params: Record<string, string | number>,
  opts: { label: string; pageSize?: number; maxRows?: number; json?: boolean } = { label: url }
): Promise<PageResult> {
  const pageSize = opts.pageSize ?? 1000;
  const maxRows = opts.maxRows ?? 5000;
  const all: Row[] = [];
  let total = 0;
  for (let page = 1; ; page++) {
    const query: Record<string, string | number> = {
      serviceKey: getDataGoKrKey(),
      pageNo: page,
      numOfRows: pageSize,
      ...params,
    };
    if (opts.json) query._type = "json";

    const doRequest = () =>
      axios.get(url, { params: query, timeout: 15_000, responseType: "text", validateStatus: () => true });
    let res = await doRequest();
    for (let i = 0; i < BACKOFF_MS.length && res.status >= 500; i++) {
      await new Promise((r) => setTimeout(r, BACKOFF_MS[i]));
      res = await doRequest();
    }
    if (res.status >= 400) {
      throw new DataGoKrError(`${opts.label}: HTTP ${res.status}`, `HTTP_${res.status}`, String(res.data).slice(0, 300));
    }
    const parsed = parseDataGoKrBody(res.data, opts.label);
    total = parsed.totalCount;
    all.push(...parsed.items);
    if (parsed.items.length < pageSize || all.length >= total || all.length >= maxRows) break;
  }
  return { items: all.slice(0, maxRows), totalCount: total };
}

/** "12,500" / " 12500 " → 12500. 실패 시 null */
export function num(v: string | undefined | null): number | null {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/,/g, "").trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 후보 키 중 처음으로 값이 있는 필드 */
export function pick(row: Row, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}
