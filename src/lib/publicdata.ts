import axios from "axios";
import { XMLParser } from "fast-xml-parser";
import { getDataGoKrKey, parseDataGoKrBody, DataGoKrError } from "./datagokr.js";

/**
 * 공공데이터포털 범용 게이트웨이.
 *  1) 카탈로그 검색  — 공공데이터활용지원센터_목록조회서비스(15077093, 자동승인) open-data-list / dataset
 *  2) 명세 조회      — 같은 카탈로그의 오퍼레이션별 요청·응답 변수 + odcloud Swagger(infuser.odcloud.kr)
 *  3) 범용 호출      — 허용 도메인(*.go.kr, *.or.kr, odcloud.kr)에 serviceKey 자동 주입, XML/JSON 정규화
 * 가짜 데이터 없음. 오류는 원인·조치(활용신청 링크 등)와 함께 그대로 노출.
 */

export const CATALOG_BASE = "https://api.odcloud.kr/api/15077093/v1";
const SWAGGER_BASE = "https://infuser.odcloud.kr/oas/docs";
const TIMEOUT = 20_000;
const MAX_TEXT = 45_000;

const xml = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true });

type Dict = Record<string, any>;

// ───────────────────────────── 공통 유틸 ─────────────────────────────

export function maskKey(s: string): string {
  let out = s;
  try {
    const k = getDataGoKrKey();
    for (const v of [k, encodeURIComponent(k)]) if (v) out = out.split(v).join("***");
  } catch {
    /* 키 없음 */
  }
  return out;
}

function yn(v: unknown): boolean {
  return String(v ?? "").trim().toUpperCase() === "Y";
}

export function splitList(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return String(v)
    .split(/\s*(?:,|\||\n|\r)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 영문명·국문명 목록을 짝지어 [{name, label}] */
export function zipParams(en: unknown, ko: unknown): { name: string; label?: string }[] {
  const a = splitList(en);
  const b = splitList(ko);
  if (a.length && b.length && a.length !== b.length) {
    // 개수가 다르면 억지로 짝짓지 않고 각각 노출
    return [...a.map((name) => ({ name })), ...b.map((name) => ({ name, label: "(국문명 — 영문과 개수 불일치)" }))];
  }
  return (a.length ? a : b).map((name, i) => (a.length && b[i] ? { name, label: b[i] } : { name }));
}

export function detailUrl(listId: string): string {
  return `https://www.data.go.kr/data/${listId}/openapi.do`;
}

async function catalogGet(path: string, params: Record<string, string | number>): Promise<Dict> {
  const key = getDataGoKrKey();
  const res = await axios.get(`${CATALOG_BASE}/${path}`, {
    params: { serviceKey: key, returnType: "JSON", ...params },
    headers: { Authorization: `Infuser ${key}` },
    timeout: TIMEOUT,
    responseType: "text",
    validateStatus: () => true,
  });
  const body = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
  if (res.status >= 400 || !body.trim().startsWith("{")) {
    throw new DataGoKrError(
      maskKey(
        `목록조회서비스 호출 실패 (HTTP ${res.status}): ${body.slice(0, 300)} — data.go.kr에서 '공공데이터활용지원센터_목록조회서비스'(15077093) 활용신청(자동승인)을 하셨는지 확인하세요: ${detailUrl("15077093")}`
      ),
      `CATALOG_HTTP_${res.status}`
    );
  }
  return JSON.parse(body);
}

// ───────────────────────────── 1) 카탈로그 검색 ─────────────────────────────

export interface ApiSummary {
  list_id: string;
  name: string;
  org: string;
  dept?: string;
  category?: string;
  data_format?: string;
  api_type?: string;
  auto_approval_dev?: string;
  auto_approval_prod?: string;
  is_charged?: string;
  endpoint?: string;
  operations: string[];
  keywords?: string;
  description?: string;
  updated_at?: string;
  detail_url: string;
}

export function groupOperations(rows: Dict[]): ApiSummary[] {
  const by = new Map<string, ApiSummary>();
  for (const r of rows) {
    if (yn(r.is_deleted) || yn(r.is_list_deleted)) continue;
    const id = String(r.list_id ?? "").trim();
    if (!id) continue;
    let s = by.get(id);
    if (!s) {
      s = {
        list_id: id,
        name: r.list_title || r.title || "",
        org: r.org_nm || "",
        dept: r.dept_nm || undefined,
        category: [r.new_category_nm, r.category_nm].filter(Boolean).join(" / ") || undefined,
        data_format: r.data_format || undefined,
        api_type: r.api_type || undefined,
        auto_approval_dev: r.is_confirmed_for_dev_nm || r.is_confirmed_for_dev || undefined,
        auto_approval_prod: r.is_confirmed_for_prod_nm || r.is_confirmed_for_prod || undefined,
        is_charged: r.is_charged || undefined,
        endpoint: r.end_point_url || undefined,
        operations: [],
        keywords: r.keywords || undefined,
        description: r.desc ? String(r.desc).slice(0, 300) : undefined,
        updated_at: r.updated_at || undefined,
        detail_url: detailUrl(id),
      };
      by.set(id, s);
    }
    const op = String(r.operation_nm ?? "").trim();
    if (op && !s.operations.includes(op)) s.operations.push(op);
  }
  return [...by.values()];
}

function matchesAll(s: ApiSummary, extra: string[]): boolean {
  if (!extra.length) return true;
  const hay = [s.name, s.org, s.keywords, s.description, s.category, s.operations.join(" ")].join(" ").toLowerCase();
  return extra.every((k) => hay.includes(k.toLowerCase()));
}

export interface SearchArgs {
  keyword: string;
  org?: string;
  kind?: "openapi" | "dataset" | "all";
  page?: number;
  per_page?: number;
}

export async function searchCatalog(args: SearchArgs) {
  const words = args.keyword.trim().split(/\s+/).filter(Boolean);
  if (!words.length) throw new DataGoKrError("keyword가 비어 있습니다.", "BAD_ARGS");
  const [first, ...extra] = words;
  const kind = args.kind ?? "openapi";
  const perPage = Math.min(Math.max(args.per_page ?? 15, 1), 50);
  const page = Math.max(args.page ?? 1, 1);
  const out: Dict = { query: args };

  if (kind === "openapi" || kind === "all") {
    // open-data-list는 한 행 = 오퍼레이션 1개 → 넉넉히 받아 list_id로 묶음
    const conds: Record<string, string | number> = { "cond[list_title::LIKE]": first, page: 1, perPage: 1000 };
    if (args.org) conds["cond[org_nm::LIKE]"] = args.org;
    let doc = await catalogGet("open-data-list", conds);
    let rows: Dict[] = doc.data ?? [];
    let via = "list_title";
    if (!rows.length) {
      delete conds["cond[list_title::LIKE]"];
      conds["cond[title::LIKE]"] = first;
      doc = await catalogGet("open-data-list", conds);
      rows = doc.data ?? [];
      via = "title";
    }
    const grouped = groupOperations(rows).filter((s) => matchesAll(s, extra));
    grouped.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
    out.openapi = {
      matched_via: `cond[${via}::LIKE]=${first}${extra.length ? ` + 추가어(${extra.join(", ")}) 필터` : ""}`,
      operation_rows_scanned: rows.length,
      operation_rows_total: doc.matchCount ?? doc.totalCount,
      apis_found: grouped.length,
      page,
      results: grouped.slice((page - 1) * perPage, page * perPage),
    };
  }

  if (kind === "dataset" || kind === "all") {
    const conds: Record<string, string | number> = { "cond[title::LIKE]": first, page, perPage: extra.length ? 200 : perPage };
    if (args.org) conds["cond[org_nm::LIKE]"] = args.org;
    const doc = await catalogGet("dataset", conds);
    const rows: Dict[] = (doc.data ?? []).filter((r: Dict) => !yn(r.is_deleted));
    const filtered = rows
      .filter((r) => {
        if (!extra.length) return true;
        const hay = [r.title, r.desc, r.keywords, r.org_nm].join(" ").toLowerCase();
        return extra.every((k) => hay.includes(k.toLowerCase()));
      })
      .slice(0, perPage)
      .map((r) => ({
        id: r.id,
        name: r.title,
        org: r.org_nm,
        type: r.list_type,
        ext: r.ext || undefined,
        category: [r.new_category_nm, r.category_nm].filter(Boolean).join(" / ") || undefined,
        swagger_json_url: r.swagger_json_url || undefined,
        page_url: r.page_url || undefined,
        updated_at: r.updated_at,
        description: r.desc ? String(r.desc).slice(0, 200) : undefined,
      }));
    out.datasets = { total: doc.matchCount ?? doc.totalCount, page, results: filtered };
  }

  out.next_step =
    "원하는 API의 list_id로 describe_public_api를 호출해 오퍼레이션·요청변수를 확인한 뒤 call_public_api로 호출하세요. 파일데이터(type이 파일)는 swagger_json_url이 있으면 그 URL로 describe_public_api(swagger_url=...)를 쓰면 됩니다.";
  return out;
}

// ───────────────────────────── 2) 명세 조회 ─────────────────────────────

export interface OperationSpec {
  operation: string;
  call_url: string;
  request_params: { name: string; label?: string }[];
  response_fields: { name: string; label?: string }[];
}

export function buildOperations(rows: Dict[]): OperationSpec[] {
  const ops = new Map<string, OperationSpec>();
  for (const r of rows) {
    if (yn(r.is_deleted)) continue;
    const opName = String(r.operation_nm ?? "").trim();
    const base = String(r.end_point_url ?? "").trim().replace(/\/+$/, "");
    let url = String(r.operation_url ?? "").trim();
    if (!url) url = opName && base ? `${base}/${opName}` : base;
    else if (!/^https?:\/\//i.test(url) && base) url = `${base}/${url.replace(/^\/+/, "")}`;
    const key = `${opName}|${url}`;
    if (ops.has(key)) continue;
    ops.set(key, {
      operation: opName || "(오퍼레이션명 없음 — 상세페이지/Swagger 확인)",
      call_url: url,
      request_params: zipParams(r.request_param_nm_en, r.request_param_nm),
      response_fields: zipParams(r.response_param_nm_en, r.response_param_nm),
    });
  }
  return [...ops.values()];
}

function resolveRef(spec: Dict, ref: string | undefined): Dict | undefined {
  if (!ref || !ref.startsWith("#/")) return undefined;
  let cur: any = spec;
  for (const p of ref.slice(2).split("/")) cur = cur?.[decodeURIComponent(p.replace(/~1/g, "/").replace(/~0/g, "~"))];
  return cur;
}

function schemaFields(spec: Dict, schema: Dict | undefined, depth = 0): string[] {
  if (!schema || depth > 4) return [];
  if (schema.$ref) return schemaFields(spec, resolveRef(spec, schema.$ref), depth + 1);
  if (schema.type === "array" || schema.items) return schemaFields(spec, schema.items, depth + 1);
  const props = schema.properties ?? {};
  const names: string[] = [];
  for (const [k, v] of Object.entries<Dict>(props)) {
    const inner = schemaFields(spec, v, depth + 1);
    if (inner.length && (k === "data" || k === "items" || k === "item" || k === "body" || k === "response")) names.push(...inner);
    else names.push(v?.description ? `${k} (${String(v.description).slice(0, 40)})` : k);
  }
  return names;
}

/** Swagger 2 / OpenAPI 3 문서 → 호출 가능한 오퍼레이션 요약 */
export function summarizeSwagger(spec: Dict) {
  let base = "";
  if (spec.servers?.[0]?.url) base = String(spec.servers[0].url);
  else if (spec.host) base = `${(spec.schemes?.includes("https") ? "https" : spec.schemes?.[0]) || "https"}://${spec.host}${spec.basePath ?? ""}`;
  base = base.replace(/\/+$/, "");
  const ops: Dict[] = [];
  for (const [path, item] of Object.entries<Dict>(spec.paths ?? {})) {
    for (const method of ["get", "post", "put", "delete"]) {
      const op = item?.[method];
      if (!op) continue;
      const params = [...(item.parameters ?? []), ...(op.parameters ?? [])]
        .map((p: Dict) => (p.$ref ? resolveRef(spec, p.$ref) ?? p : p))
        .filter((p: Dict) => !/^(servicekey|authorization)$/i.test(String(p.name ?? "")))
        .map((p: Dict) => ({
          name: p.name,
          in: p.in,
          required: !!p.required,
          type: p.type ?? p.schema?.type,
          description: p.description ? String(p.description).slice(0, 120) : undefined,
        }));
      const resp = op.responses?.["200"] ?? op.responses?.default;
      const respSchema = resp?.schema ?? resp?.content?.["application/json"]?.schema;
      const bodySchema = op.requestBody?.content?.["application/json"]?.schema;
      ops.push({
        method: method.toUpperCase(),
        call_url: `${base}${path}`,
        summary: op.summary ?? op.description?.slice(0, 120),
        params,
        ...(bodySchema ? { json_body_fields: schemaFields(spec, bodySchema) } : {}),
        response_fields: schemaFields(spec, respSchema).slice(0, 80),
      });
    }
  }
  return { title: spec.info?.title, version: spec.info?.version, base_url: base, operations: ops };
}

async function fetchSwagger(url: string): Promise<Dict> {
  assertAllowedUrl(url);
  const res = await axios.get(url, { timeout: TIMEOUT, responseType: "text", validateStatus: () => true });
  const body = String(res.data ?? "").trim();
  if (res.status >= 400 || !body.startsWith("{")) throw new DataGoKrError(`Swagger 조회 실패 (HTTP ${res.status})`, "SWAGGER_FAILED");
  return JSON.parse(body);
}

export interface DescribeArgs {
  list_id?: string;
  swagger_url?: string;
}

export async function describeApi(args: DescribeArgs) {
  if (!args.list_id && !args.swagger_url) throw new DataGoKrError("list_id 또는 swagger_url 중 하나가 필요합니다.", "BAD_ARGS");
  const out: Dict = {};

  if (args.list_id) {
    const listId = args.list_id.trim();
    const rows: Dict[] = [];
    for (let page = 1; page <= 5; page++) {
      const doc = await catalogGet("open-data-list", { "cond[list_id::EQ]": listId, page, perPage: 200 });
      const data: Dict[] = doc.data ?? [];
      rows.push(...data);
      if (data.length < 200) break;
    }
    if (rows.length) {
      const r0 = rows[0];
      out.api = {
        list_id: listId,
        name: r0.list_title,
        service_name: r0.title,
        org: r0.org_nm,
        dept: r0.dept_nm,
        data_format: r0.data_format,
        api_type: r0.api_type,
        endpoint: r0.end_point_url,
        auto_approval: { dev: r0.is_confirmed_for_dev_nm || r0.is_confirmed_for_dev, prod: r0.is_confirmed_for_prod_nm || r0.is_confirmed_for_prod },
        is_charged: r0.is_charged,
        guide_url: r0.guide_url || undefined,
        detail_url: detailUrl(listId),
        description: r0.desc,
        retired: yn(r0.is_list_deleted) || rows.every((r) => yn(r.is_deleted)),
      };
      out.operations = buildOperations(rows);
    } else {
      out.api = { list_id: listId, detail_url: detailUrl(listId), note: "목록조회서비스에 오퍼레이션 정보가 없습니다(파일데이터·odcloud형이거나 폐기). Swagger를 시도합니다." };
    }

    const endpoint = String(out.api?.endpoint ?? "");
    const noParams = !out.operations?.length || out.operations.every((o: OperationSpec) => o.request_params.length <= 3);
    if (!args.swagger_url && (endpoint.includes("odcloud") || noParams)) {
      try {
        out.swagger = summarizeSwagger(await fetchSwagger(`${SWAGGER_BASE}?namespace=${encodeURIComponent(listId)}/v1`));
      } catch (e: any) {
        out.swagger_note = `odcloud Swagger 없음(${e.message}). 요청변수가 공통변수뿐이면 상세페이지(${detailUrl(listId)})의 'Swagger/참고문서'를 확인하세요.`;
      }
    }
  }

  if (args.swagger_url) out.swagger = summarizeSwagger(await fetchSwagger(args.swagger_url));

  out.how_to_call = [
    "call_public_api(url=operations[].call_url 또는 swagger.operations[].call_url, params={요청변수: 값}).",
    "serviceKey는 서버가 자동 주입하니 params에 넣지 마세요. pageNo·numOfRows(전통형) / page·perPage(odcloud형)는 서버가 처리합니다.",
    "JSON이 가능한 전통형 API는 params에 _type='json' 또는 dataType/resultType='json'(API마다 이름이 다름)을 주면 빠릅니다. 생략해도 XML을 자동 변환합니다.",
    "활용신청이 안 된 API는 'SERVICE_KEY_IS_NOT_REGISTERED'(코드 30) 또는 403이 납니다 → detail_url에서 활용신청(대부분 자동승인, 반영까지 최대 1~2시간).",
  ];
  return out;
}

// ───────────────────────────── 3) 범용 호출 ─────────────────────────────

const DEFAULT_ALLOWED_SUFFIXES = [".go.kr", ".or.kr", "odcloud.kr", ".re.kr"];

export function allowedSuffixes(): string[] {
  const extra = splitList(process.env.PUBLIC_API_EXTRA_HOSTS);
  return [...DEFAULT_ALLOWED_SUFFIXES, ...extra.map((h) => h.toLowerCase())];
}

export function assertAllowedUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new DataGoKrError(`URL 형식이 아닙니다: ${raw}`, "BAD_URL");
  }
  if (!/^https?:$/.test(u.protocol)) throw new DataGoKrError("http/https만 허용됩니다.", "BAD_URL");
  const host = u.hostname.toLowerCase();
  if (/^[\d.]+$/.test(host) || host.includes(":") || host === "localhost") {
    throw new DataGoKrError("IP 주소·localhost는 호출할 수 없습니다.", "HOST_NOT_ALLOWED");
  }
  const ok = allowedSuffixes().some((s) => (s.startsWith(".") ? host.endsWith(s) : host === s || host.endsWith(`.${s}`)));
  if (!ok) {
    throw new DataGoKrError(
      `허용되지 않은 호스트입니다: ${host}. 공공기관 도메인(${allowedSuffixes().join(", ")})만 호출합니다. 필요하면 환경변수 PUBLIC_API_EXTRA_HOSTS에 추가하세요.`,
      "HOST_NOT_ALLOWED"
    );
  }
  // 포털 게이트웨이는 https 지원 → 키 보호를 위해 승격
  if (u.protocol === "http:" && (host === "apis.data.go.kr" || host.endsWith("odcloud.kr"))) u.protocol = "https:";
  return u;
}

function decodeBody(buf: ArrayBuffer | Buffer, contentType: string): string {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let charset = /charset=([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase();
  if (!charset) {
    const head = bytes.subarray(0, 200).toString("latin1");
    charset = /encoding=["']([\w-]+)["']/i.exec(head)?.[1]?.toLowerCase();
  }
  if (charset && /euc-?kr|ks_c_5601|cp949|ms949/.test(charset)) {
    try {
      return new TextDecoder("euc-kr").decode(bytes);
    } catch {
      /* ICU 미포함 빌드 */
    }
  }
  return bytes.toString("utf8");
}

const ERROR_HINTS: Record<string, string> = {
  "1": "기관 시스템 내부 오류(APPLICATION_ERROR). 잠시 후 재시도하세요.",
  "3": "데이터 없음(NODATA_ERROR). 조건(날짜·지역코드 등)을 바꿔보세요.",
  "4": "HTTP 오류. 호출 URL·메서드(GET/POST)를 명세와 대조하세요.",
  "5": "기관 서버 응답 지연(SERVICETIMEOUT). 잠시 후 재시도하세요.",
  "10": "요청 파라미터 오류. describe_public_api의 request_params 이름·형식(YYYYMMDD 등)을 확인하세요.",
  "11": "필수 파라미터 누락.",
  "12": "해당 오픈API 서비스가 없거나 폐기됨. URL 오타 또는 신규 버전(_2 등) 여부를 확인하세요.",
  "20": "접근 거부(PERMISSION_DENIED). 이 API의 활용신청이 필요합니다.",
  "22": "일일 트래픽 초과. 내일 다시 하거나 운영계정 신청으로 트래픽을 늘리세요.",
  "30": "등록되지 않은 서비스키(SERVICE_KEY_IS_NOT_REGISTERED). 이 API를 활용신청하지 않았거나 승인 반영 전(최대 1~2시간)입니다.",
  "31": "활용기간 만료. 마이페이지에서 연장 신청하세요.",
  "32": "등록되지 않은 IP.",
};

function hintFor(message: string, code?: string): string | undefined {
  const m = /reasonCode\s*(\d+)|resultCode\s*0*(\d+)|RESULT_0*(\d+)/i.exec(`${message} ${code ?? ""}`);
  const c = m ? (m[1] ?? m[2] ?? m[3]) : undefined;
  if (c && ERROR_HINTS[c]) return ERROR_HINTS[c];
  if (/NOT_REGISTERED|등록되지 않은/i.test(message)) return ERROR_HINTS["30"];
  if (/LIMITED_NUMBER|트래픽/i.test(message)) return ERROR_HINTS["22"];
  if (/DEADLINE|기간/i.test(message)) return ERROR_HINTS["31"];
  return undefined;
}

export interface NormalizedPage {
  style: "gateway" | "odcloud" | "raw";
  rows: Dict[];
  totalCount?: number;
  raw?: unknown;
}

export function normalizeResponse(text: string, label: string): NormalizedPage {
  const s = text.trim();
  let doc: any;
  if (s.startsWith("{") || s.startsWith("[")) {
    try {
      doc = JSON.parse(s);
    } catch {
      throw new DataGoKrError(`${label}: JSON 파싱 실패 — ${s.slice(0, 200)}`, "PARSE_FAILED");
    }
  } else if (s.startsWith("<")) {
    doc = xml.parse(s);
  } else {
    throw new DataGoKrError(`${label}: 알 수 없는 응답 — ${s.slice(0, 300)}`, "UNKNOWN_BODY");
  }

  // odcloud형: { page, perPage, totalCount, currentCount, matchCount, data: [] }
  if (doc && !Array.isArray(doc) && Array.isArray(doc.data) && ("currentCount" in doc || "perPage" in doc || "matchCount" in doc)) {
    return { style: "odcloud", rows: doc.data, totalCount: Number(doc.matchCount ?? doc.totalCount) || doc.data.length };
  }
  // odcloud 오류: { code: -4, msg: "..." }
  if (doc && typeof doc.code === "number" && doc.code < 0 && doc.msg) {
    throw new DataGoKrError(`${label}: ${doc.msg} (code ${doc.code})`, `ODCLOUD_${doc.code}`);
  }
  // 전통형 게이트웨이(response/header/body/items/item) 또는 게이트웨이 인증 오류
  if (doc?.OpenAPI_ServiceResponse || doc?.response?.header || doc?.response?.body || doc?.header?.resultCode !== undefined) {
    const r = parseDataGoKrBody(doc, label);
    if (r.items.length || r.totalCount || doc?.response?.body) return { style: "gateway", rows: r.items, totalCount: r.totalCount };
  }
  // 그 외(기관 자체 포맷: 서울 열린데이터형 등) — 첫 번째 배열을 행으로 추정, 원문도 함께
  const arr = findFirstArray(doc);
  return { style: "raw", rows: arr ?? [], raw: arr ? undefined : doc };
}

function findFirstArray(o: any, depth = 0): Dict[] | undefined {
  if (!o || typeof o !== "object" || depth > 5) return undefined;
  if (Array.isArray(o)) return o.length && typeof o[0] === "object" ? o : undefined;
  for (const v of Object.values(o)) {
    const f = findFirstArray(v, depth + 1);
    if (f) return f;
  }
  // 단건(item 객체 1개)
  if (o.item && typeof o.item === "object") return [o.item];
  return undefined;
}

export interface CallArgs {
  url: string;
  params?: Record<string, string | number | boolean>;
  method?: "GET" | "POST";
  json_body?: unknown;
  key_param?: string;
  inject_key?: boolean;
  all_pages?: boolean;
  max_rows?: number;
  page_size?: number;
  list_id?: string;
}

const KEY_NAMES = /^(service_?key|servicekey|authkey|apikey|api_key|key|crtfc_key)$/i;

export async function callApi(args: CallArgs) {
  const u = assertAllowedUrl(args.url);
  const host = u.hostname.toLowerCase();
  const isOdcloud = host.endsWith("odcloud.kr");
  const method = args.method ?? (args.json_body !== undefined ? "POST" : "GET");
  const maxRows = Math.min(Math.max(args.max_rows ?? 100, 1), 2000);
  const inject = args.inject_key !== false;
  const keyParam = args.key_param ?? "serviceKey";

  // 사용자가 준 키성 파라미터는 버리고 서버 키를 넣는다 (키 노출·오입력 방지)
  const userParams: Dict = {};
  for (const [k, v] of Object.entries(args.params ?? {})) {
    if (inject && KEY_NAMES.test(k)) continue;
    if (v === undefined || v === null) continue;
    userParams[k] = String(v);
  }
  // URL에 박혀 온 쿼리도 병합(키성 파라미터 제거)
  for (const [k, v] of [...u.searchParams.entries()]) {
    if (inject && KEY_NAMES.test(k)) {
      u.searchParams.delete(k);
      continue;
    }
    if (!(k in userParams)) userParams[k] = v;
    u.searchParams.delete(k);
  }

  const pageKey = isOdcloud ? "page" : "pageNo";
  const sizeKey = isOdcloud ? "perPage" : "numOfRows";
  const explicitPage = pageKey in userParams;
  const pageSize = Math.min(Number(userParams[sizeKey] ?? args.page_size ?? Math.min(maxRows, 1000)), 1000);
  let page = Number(userParams[pageKey] ?? 1);

  const headers: Dict = { Accept: "application/json, application/xml;q=0.9, */*;q=0.8" };
  let key = "";
  if (inject) {
    key = getDataGoKrKey();
    if (isOdcloud) headers.Authorization = `Infuser ${key}`;
  }

  const rows: Dict[] = [];
  let total: number | undefined;
  let style: NormalizedPage["style"] = "raw";
  let raw: unknown;
  let pagesFetched = 0;
  const label = `${host}${u.pathname}`;

  try {
    while (true) {
      const query: Dict = { ...userParams, [pageKey]: page, [sizeKey]: pageSize };
      if (inject) query[keyParam] = key;
      const res = await axios.request({
        url: u.toString(),
        method,
        params: query,
        data: method === "POST" ? args.json_body ?? {} : undefined,
        headers: method === "POST" ? { ...headers, "Content-Type": "application/json" } : headers,
        timeout: 30_000,
        responseType: "arraybuffer",
        validateStatus: () => true,
        maxRedirects: 3,
      });
      const text = decodeBody(res.data, String(res.headers["content-type"] ?? ""));
      if (res.status >= 400) {
        throw new DataGoKrError(`${label}: HTTP ${res.status} — ${text.slice(0, 300)}`, `HTTP_${res.status}`);
      }
      const n = normalizeResponse(text, label);
      pagesFetched++;
      style = n.style;
      if (n.style === "raw" && !n.rows.length) {
        raw = n.raw;
        break;
      }
      rows.push(...n.rows);
      total = n.totalCount ?? total;
      const more = args.all_pages && !explicitPage && n.style !== "raw" && n.rows.length >= pageSize && rows.length < (total ?? Infinity) && rows.length < maxRows;
      if (!more || pagesFetched >= 50) break;
      page++;
    }
  } catch (e: any) {
    const msg = maskKey(String(e?.message ?? e));
    const hint = hintFor(msg, e?.code);
    const link = args.list_id ? detailUrl(args.list_id) : "https://www.data.go.kr (해당 API 상세페이지)";
    throw new DataGoKrError(`${msg}${hint ? ` → ${hint}` : ""}${hint && /활용신청|서비스키/.test(hint) ? ` 활용신청: ${link}` : ""}`, e?.code ?? "CALL_FAILED");
  }

  const result: Dict = {
    request: { url: `${u.origin}${u.pathname}`, method, params: userParams, key_injected: inject ? `${keyParam}=***` : false },
    response_style: style,
    total_count: total,
    pages_fetched: pagesFetched,
    returned_rows: Math.min(rows.length, maxRows),
    rows: rows.slice(0, maxRows),
  };
  if (raw !== undefined) result.raw = raw;
  if (total !== undefined && total > rows.length && !args.all_pages) {
    result.note = `전체 ${total}건 중 ${rows.length}건만 받았습니다. all_pages=true(최대 max_rows) 또는 params에 ${pageKey}를 지정하세요.`;
  }

  let text = JSON.stringify(result, null, 2);
  if (text.length > MAX_TEXT) {
    // 행 수를 줄여 응답 크기 제한 준수
    const per = Math.max(1, Math.floor((result.rows.length * MAX_TEXT) / text.length) - 1);
    result.rows = result.rows.slice(0, per);
    result.returned_rows = per;
    result.truncated = `응답이 커서 ${per}행만 표시했습니다(전체 수신 ${rows.length}행). 조건을 좁히거나 max_rows를 줄이세요.`;
    text = JSON.stringify(result, null, 2);
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + "\n…(잘림)";
  }
  return maskKey(text);
}
