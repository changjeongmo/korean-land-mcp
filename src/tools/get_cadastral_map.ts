import axios from "axios";
import sharp from "sharp";
import { getFeatures, VWorldFeature } from "../lib/vworld.js";
import { resolveToParcel } from "../lib/resolve.js";
import { DISCLAIMER } from "../lib/disclaimer.js";

type Ring = [number, number][];

function ringsOf(geom: unknown): Ring[] {
  const g = geom as { type?: string; coordinates?: unknown } | undefined;
  if (!g || !g.coordinates) return [];
  if (g.type === "Polygon") {
    const c = g.coordinates as number[][][];
    return c[0] ? [c[0] as Ring] : [];
  }
  if (g.type === "MultiPolygon") {
    return (g.coordinates as number[][][][]).filter((p) => p?.[0]).map((p) => p[0] as Ring);
  }
  return [];
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Pure renderer (exported for tests): WGS84 polygons → SVG string. */
export function renderCadastralSvg(
  target: VWorldFeature[],
  neighbors: VWorldFeature[],
  bbox: [number, number, number, number],
  title: string,
  px = 900
): string {
  const [minx, miny, maxx, maxy] = bbox;
  const midLat = (miny + maxy) / 2;
  const kx = Math.cos((midLat * Math.PI) / 180); // lon degrees shrink with latitude
  const spanX = (maxx - minx) * kx;
  const spanY = maxy - miny;
  const s = px / Math.max(spanX, spanY);
  const ox = (px - spanX * s) / 2;
  const oy = (px - spanY * s) / 2;
  const P = (x: number, y: number): [number, number] => [ox + (x - minx) * kx * s, px - (oy + (y - miny) * s)];

  const parts: string[] = [];
  const draw = (f: VWorldFeature, isTarget: boolean) => {
    const rings = ringsOf(f.geometry);
    for (const r of rings) {
      const pts = r.map(([x, y]) => P(x, y).map((v) => v.toFixed(1)).join(",")).join(" ");
      parts.push(
        isTarget
          ? `<polygon points="${pts}" fill="#FFDCDC" stroke="#C80000" stroke-width="4"/>`
          : `<polygon points="${pts}" fill="none" stroke="#5A5A5A" stroke-width="1.2"/>`
      );
    }
    const label = String(f.properties?.jibun ?? "");
    if (label && rings.length) {
      const ring = rings.reduce((a, b) => (b.length > a.length ? b : a));
      const cx = ring.reduce((a, p) => a + p[0], 0) / ring.length;
      const cy = ring.reduce((a, p) => a + p[1], 0) / ring.length;
      const [X, Y] = P(cx, cy);
      if (X >= 0 && X <= px && Y >= 0 && Y <= px) {
        parts.push(
          `<text x="${X.toFixed(1)}" y="${Y.toFixed(1)}" font-size="${isTarget ? 17 : 14}" font-weight="${isTarget ? 700 : 400}" fill="${isTarget ? "#B40000" : "#282828"}" text-anchor="middle" dominant-baseline="middle">${esc(label)}</text>`
        );
      }
    }
  };
  neighbors.forEach((f) => draw(f, false));
  target.forEach((f) => draw(f, true));

  // scale bar
  const spanM = spanX * 111_320;
  const steps = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
  const barM = steps.find((v) => v >= spanM / 5) ?? 5000;
  const barPx = (barM / 111_320) * s;
  const bx = px - barPx - 30;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px + 60}" viewBox="0 0 ${px} ${px + 60}" font-family="Noto Sans CJK KR, NanumGothic, sans-serif">
<rect width="100%" height="100%" fill="#FFFFFF"/>
${parts.join("\n")}
<rect x="${bx.toFixed(1)}" y="${px - 30}" width="${barPx.toFixed(1)}" height="6" fill="#000"/>
<text x="${bx.toFixed(1)}" y="${px - 38}" font-size="13" fill="#000">${barM} m</text>
<text x="30" y="40" font-size="20" font-weight="700" fill="#000">N ↑</text>
<rect x="0" y="${px}" width="${px}" height="60" fill="#1F3864"/>
<text x="16" y="${px + 26}" font-size="19" font-weight="700" fill="#FFFFFF">${esc(title)}</text>
<text x="16" y="${px + 49}" font-size="13" fill="#DCE6F5">연속지적도(지적도+임야도 편집) · 참고용 · 출처 V-World</text>
</svg>`;
}

async function landArea(pnu: string): Promise<{ area_m2: number | null; jimok: string | null; year: string | null }> {
  try {
    const params: Record<string, string> = {
      pnu,
      key: process.env.VWORLD_API_KEY ?? "",
      domain: process.env.VWORLD_DOMAIN ?? "",
      format: "json",
      numOfRows: "10",
      pageNo: "1",
    };
    const res = await axios.get("https://api.vworld.kr/ned/data/getLandCharacteristics", { params, timeout: 10_000 });
    const box = Object.values(res.data ?? {}).find((v: any) => v && typeof v === "object" && "field" in v) as any;
    const rows: any[] = box ? (Array.isArray(box.field) ? box.field : [box.field]) : [];
    if (!rows.length) return { area_m2: null, jimok: null, year: null };
    const r = rows.sort((a, b) => String(b.stdrYear).localeCompare(String(a.stdrYear)))[0];
    const a = parseFloat(r.lndpclAr);
    return { area_m2: Number.isFinite(a) ? a : null, jimok: r.lndcgrCodeNm ?? null, year: r.stdrYear ?? null };
  } catch {
    return { area_m2: null, jimok: null, year: null };
  }
}

export const getCadastralMapTool = async ({ query, buffer_m }: { query: string; buffer_m?: number }) => {
  const buf = Math.max(20, Math.min(buffer_m ?? 60, 500));
  const r = await resolveToParcel(query);
  if (!r.pnu || !r.parcel_geometry) {
    return { content: [{ type: "text" as const, text: `지적도 조회 불가: '${query}'에 해당하는 연속지적도 필지를 찾지 못했습니다. 지번 주소(임야는 '산' 포함) 또는 PNU로 다시 시도하세요.` }] };
  }
  const target: VWorldFeature = { properties: { jibun: r.jibun, pnu: r.pnu }, geometry: r.parcel_geometry };
  const pts = ringsOf(r.parcel_geometry).flat();
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const lat = (Math.min(...ys) + Math.max(...ys)) / 2;
  const dLat = buf / 111_320;
  const dLon = buf / (111_320 * Math.cos((lat * Math.PI) / 180));
  let minx = Math.min(...xs) - dLon, maxx = Math.max(...xs) + dLon;
  let miny = Math.min(...ys) - dLat, maxy = Math.max(...ys) + dLat;
  // square the frame in metres
  const kx = Math.cos((lat * Math.PI) / 180);
  const w = (maxx - minx) * kx, h = maxy - miny;
  if (w > h) { const d = (w - h) / 2; miny -= d; maxy += d; } else { const d = (h - w) / 2 / kx; minx -= d; maxx += d; }

  let neighbors: VWorldFeature[] = [];
  let neighborError: string | null = null;
  try {
    neighbors = await getFeatures({
      layer: "LP_PA_CBND_BUBUN",
      geomFilter: `BOX(${minx},${miny},${maxx},${maxy})`,
      includeGeometry: true,
      size: 1000,
    });
    neighbors = neighbors.filter((f) => String(f.properties?.pnu) !== r.pnu);
  } catch (e) {
    neighborError = (e as Error).message;
  }

  const title = `${r.address ?? query}  (${r.jibun ?? ""})`;
  const svg = renderCadastralSvg([target], neighbors, [minx, miny, maxx, maxy], title);
  const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
  const area = await landArea(r.pnu);

  const lines = [
    `■ 지적도: ${r.address ?? query} / 지번·지목 ${r.jibun ?? "-"} / PNU ${r.pnu}`,
    area.area_m2 != null
      ? `  면적: ${area.area_m2.toLocaleString("ko-KR")}㎡ (${(area.area_m2 / 3.305785).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}평) · 지목 ${area.jimok ?? "-"} · ${area.year ?? ""}년 토지특성 기준`
      : "  면적: 조회 불가(토지특성 API 응답 없음)",
    `  표시 범위: 필지 외곽 +${buf}m, 주변 필지 ${neighbors.length}개` + (neighborError ? ` (주변 필지 조회 오류: ${neighborError})` : ""),
    "  연속지적도는 지적도와 임야도를 편집한 참고도면으로 경계·면적의 법적 근거가 아닙니다(지적도·임야도 등본, 측량으로 확인).",
    DISCLAIMER,
  ];
  return {
    content: [
      { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
      { type: "text" as const, text: lines.join("\n") },
    ],
  };
};
