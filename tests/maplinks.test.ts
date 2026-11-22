import { describe, it, expect } from "vitest";
import { buildMapLinks } from "../src/lib/maplinks.js";

describe("map links", () => {
  const l = buildMapLinks({ lat: 37.536138, lng: 127.084080, name: "자양동, 680", address: "서울특별시 광진구 자양동 680", pnu: "1121510500106800000" });
  it("kakao: lat before lng, comma stripped from name", () => {
    expect(l.kakao.map).toBe(`https://map.kakao.com/link/map/${encodeURIComponent("자양동  680")},37.536138,127.08408`);
    expect(l.kakao.roadview).toBe("https://map.kakao.com/link/roadview/37.536138,127.08408");
    expect(l.kakao.route_to.startsWith("https://map.kakao.com/link/to/")).toBe(true);
  });
  it("naver: nmap place has required appname", () => {
    expect(l.naver.app_place).toMatch(/^nmap:\/\/place\?lat=37.536138&lng=127.08408&name=.+&appname=/);
    expect(l.naver.web_search).toContain("map.naver.com/p/search/");
  });
  it("eum: pnu deep link only for 19 digits", () => {
    expect(l.eum.land_use_plan).toContain("pnu=1121510500106800000");
    expect(buildMapLinks({ lat: 1, lng: 1, name: "x", pnu: "123" }).eum.land_use_plan).toBeNull();
  });
});
