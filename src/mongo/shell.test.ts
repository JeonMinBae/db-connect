import { describe, expect, it } from "vitest";
import { formatShell, parseShellValue, ShellError } from "./shell";

describe("parseShellValue", () => {
  it("parses shell literals to canonical extended JSON", () => {
    const v = parseShellValue(`{ _id: ObjectId("65F0A1B2C3D4E5F601234567"), 'n': 5, big: 9007199254740993, d: 1.5, e: 2.0,
      at: { $gt: ISODate("2026-10-01") }, tags: ['a', "b",], re: /ab+c/i, dec: NumberDecimal("1.10"), nl: NumberLong(7), x: null, ok: true }`);
    expect(v).toEqual({
      _id: { $oid: "65f0a1b2c3d4e5f601234567" },
      n: { $numberInt: "5" },
      big: { $numberLong: "9007199254740993" },
      d: { $numberDouble: "1.5" },
      e: { $numberDouble: "2.0" },
      at: { $gt: { $date: { $numberLong: String(Date.UTC(2026, 9, 1)) } } },
      tags: ["a", "b"],
      re: { $regularExpression: { pattern: "ab+c", options: "i" } },
      dec: { $numberDecimal: "1.10" },
      nl: { $numberLong: "7" },
      x: null,
      ok: true,
    });
  });

  it("handles negatives, new Date, UUID, BinData, Timestamp and comments", () => {
    expect(parseShellValue("-3")).toEqual({ $numberInt: "-3" });
    expect(parseShellValue('new Date("2020-01-01T00:00:00Z") // c')).toEqual({ $date: { $numberLong: "1577836800000" } });
    expect(parseShellValue('UUID("00112233-4455-6677-8899-aabbccddeeff")')).toEqual({ $binary: { base64: "ABEiM0RVZneImaq7zN3u/w==", subType: "04" } });
    expect(parseShellValue('BinData(0, "AQI=")')).toEqual({ $binary: { base64: "AQI=", subType: "00" } });
    expect(parseShellValue("Timestamp({ t: 5, i: 1 })")).toEqual({ $timestamp: { t: 5, i: 1 } });
  });

  it("reports errors with positions", () => {
    expect(() => parseShellValue("{ a: 1 ")).toThrow(ShellError);
    expect(() => parseShellValue('ObjectId("xyz")')).toThrow(/24자리/);
    expect(() => parseShellValue("{ a: foo }")).toThrow(/알 수 없는 이름/);
    try {
      parseShellValue("{ a: 1, b: @ }");
    } catch (e) {
      expect((e as ShellError).at).toBe(11);
    }
  });
});

describe("formatShell", () => {
  it("round-trips", () => {
    const texts = [
      '{ _id: ObjectId("65f0a1b2c3d4e5f601234567"), n: 5, d: 2.0, big: NumberLong("9007199254740993") }',
      '{ at: ISODate("2026-10-01T00:00:00.000Z"), re: /a.c/i, dec: NumberDecimal("1.10") }',
      '{ u: UUID("00112233-4455-6677-8899-aabbccddeeff"), b: BinData(0, "AQI="), ts: Timestamp({ t: 5, i: 1 }) }',
      '{ "weird key": [ 1, "x", null, true ], nested: { a: { b: [] } }, empty: {} }',
    ];
    for (const t of texts) {
      const v = parseShellValue(t);
      expect(formatShell(v)).toBe(t);
      expect(parseShellValue(formatShell(v))).toEqual(v);
    }
  });

  it("indents for the JSON view", () => {
    expect(formatShell({ a: { $numberInt: "1" }, b: [true] }, 2)).toBe("{\n  a: 1,\n  b: [\n    true\n  ]\n}");
  });
});
