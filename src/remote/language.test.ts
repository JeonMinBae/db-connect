import { describe, expect, it } from "vitest";
import { languageKey } from "./language";

describe("languageKey", () => {
  it("별칭·대소문자를 처리하고 모르는 확장자는 null", () => {
    expect(languageKey("App.TSX")).toBe("ts");
    expect(languageKey("docker-compose.yaml")).toBe("yml");
    expect(languageKey("a.sql")).toBe("sql");
    expect(languageKey(".env")).toBeNull();
    expect(languageKey("Makefile")).toBeNull();
    expect(languageKey("a.unknown")).toBeNull();
  });
});
