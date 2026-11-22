import { resolveToPoint } from "../lib/resolve.js";
import { addressSearchFirst } from "../lib/kakao.js";
import { buildMapLinks } from "../lib/maplinks.js";

export const getMapLinksTool = async ({ query, name }: { query: string; name?: string }) => {
  let lat: number | undefined;
  let lng: number | undefined;
  let address: string | null = null;
  let pnu: string | null = null;
  let via = "";
  const errors: string[] = [];

  try {
    const r = await resolveToPoint(query);
    lat = r.point_wgs84.y;
    lng = r.point_wgs84.x;
    address = r.address;
    pnu = r.pnu;
    via = "V-World 지오코딩·연속지적도";
  } catch (e: any) {
    errors.push(`V-World: ${e?.message ?? e}`);
  }
  if (lat === undefined && process.env.KAKAO_REST_KEY) {
    try {
      const k = await addressSearchFirst(query);
      if (k) {
        lat = k.y;
        lng = k.x;
        address = k.address;
        via = "카카오 주소검색";
      }
    } catch (e: any) {
      errors.push(`Kakao: ${e?.message ?? e}`);
    }
  }
  if (lat === undefined || lng === undefined) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ error: `'${query}'의 좌표를 찾지 못했습니다.`, details: errors }, null, 2) }],
      isError: true,
    };
  }

  const label = name || address || query;
  const links = buildMapLinks({ lat, lng, name: label, address, pnu });
  const md = [
    `**${label}**`,
    `- 카카오맵(다음지도): [지도](${links.kakao.map}) · [로드뷰](${links.kakao.roadview}) · [길찾기](${links.kakao.route_to})`,
    `- 네이버지도: [웹 검색](${links.naver.web_search}) · 앱: \`${links.naver.app_place}\``,
    links.eum.land_use_plan ? `- 토지이음: [토지이용계획 열람](${links.eum.land_use_plan})` : `- 토지이음: [열람 화면](${links.eum.home}) (PNU 미확인 — 주소 직접 입력)`,
  ].join("\n");

  const result = {
    query,
    point_wgs84: { lat, lng },
    address,
    pnu,
    resolved_via: via,
    links,
    markdown: md,
    notes: [
      "카카오 링크는 PC·모바일웹·카카오맵 앱에서 자동으로 열립니다.",
      "nmap:// 링크는 네이버지도 앱이 설치된 휴대폰에서만 열립니다. 앱이 없거나 PC면 web_search 링크를 쓰세요.",
      "토지이음은 공개 API가 없어 링크로 연결합니다. 같은 토지이용계획 내용(용도지역·지구·구역, 다른 법령 지정사항, 지구단위계획)은 get_zoning / get_other_law_designations / get_district_plan / analyze_parcel 로 데이터로 받으세요.",
      "토지이음 바로가기는 사이트 개편 시 주소가 바뀔 수 있습니다. 열리지 않으면 home 링크에서 주소를 입력하세요.",
    ],
  };
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
};
