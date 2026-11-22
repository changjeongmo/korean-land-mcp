/**
 * 지도 바로가기 링크 생성 (키 불필요, 순수 함수).
 *  - 카카오맵(다음지도): https://map.kakao.com/link/{map|to}/이름,위도,경도 , /link/roadview/위도,경도
 *    (위도=y 먼저 — 카카오 DevTalk 공식 답변 기준)
 *  - 네이버지도: 앱 URL Scheme nmap://place?lat&lng&name&appname (NAVER Cloud Maps 가이드),
 *    nmap://search?query=…, 웹은 map.naver.com 검색 URL
 *  - 토지이음: PNU 기반 토지이용계획 열람 페이지 (공개 API 없음 → 링크 + V-World 기반 도구로 동일 정보 조회)
 */

export const NAVER_APPNAME = "https://claude.ai";

export interface MapPoint {
  lat: number;
  lng: number;
  name: string;
  address?: string | null;
  pnu?: string | null;
}

const enc = encodeURIComponent;

function clean(name: string): string {
  // 카카오 링크는 콤마를 구분자로 쓰므로 이름의 콤마 제거
  return name.replace(/,/g, " ").trim() || "대상지";
}

export function kakaoLinks(p: MapPoint) {
  const n = enc(clean(p.name));
  return {
    map: `https://map.kakao.com/link/map/${n},${p.lat},${p.lng}`,
    roadview: `https://map.kakao.com/link/roadview/${p.lat},${p.lng}`,
    route_to: `https://map.kakao.com/link/to/${n},${p.lat},${p.lng}`,
    ...(p.address ? { search: `https://map.kakao.com/link/search/${enc(p.address)}` } : {}),
  };
}

export function naverLinks(p: MapPoint, appname = NAVER_APPNAME) {
  const q = p.address || p.name;
  return {
    web_search: `https://map.naver.com/p/search/${enc(q)}`,
    app_place: `nmap://place?lat=${p.lat}&lng=${p.lng}&name=${enc(clean(p.name))}&appname=${enc(appname)}`,
    app_search: `nmap://search?query=${enc(q)}&appname=${enc(appname)}`,
    app_map: `nmap://map?lat=${p.lat}&lng=${p.lng}&zoom=18&appname=${enc(appname)}`,
  };
}

export function eumLinks(pnu?: string | null) {
  return {
    land_use_plan: pnu && /^\d{19}$/.test(pnu)
      ? `https://www.eum.go.kr/web/ar/lu/luLandDet.jsp?pnu=${pnu}&mode=search&isNoScr=script&selGbn=umd`
      : null,
    home: "https://www.eum.go.kr/web/ar/lu/luLandDet.jsp",
    mobile: "https://m.eum.go.kr",
  };
}

export function buildMapLinks(p: MapPoint) {
  return { kakao: kakaoLinks(p), naver: naverLinks(p), eum: eumLinks(p.pnu) };
}
