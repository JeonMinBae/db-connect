import { describe, expect, it } from "vitest";
import { NULL, text, type ColumnMeta } from "../api/types";
import { editorKind, fromDatetimeInput, toDateInput, toDatetimeInput } from "./editors";

const m = (data_type: string, full_type = data_type, enum_values: string[] | null = null): ColumnMeta => ({
  name: "c",
  data_type,
  full_type,
  nullable: true,
  is_pk: false,
  is_unique_not_null: false,
  enum_values,
  ordinal: 1,
});

describe("editorKind", () => {
  it("maps column types to editors", () => {
    expect(editorKind(m("date"), text("2020-01-01"))).toBe("date");
    expect(editorKind(m("timestamp", "timestamp without time zone"), NULL)).toBe("datetime");
    expect(editorKind(m("datetime"), NULL)).toBe("datetime");
    expect(editorKind(m("timestamptz", "timestamp with time zone"), NULL)).toBeNull();
    expect(editorKind(m("mood", "mood", ["sad", "ok"]), NULL)).toBe("enum");
    expect(editorKind(m("enum", "enum('a','b')", ["a", "b"]), NULL)).toBe("enum");
    expect(editorKind(m("bool"), text("t"))).toBe("bool");
    expect(editorKind(m("tinyint", "tinyint(1)"), text("1"))).toBe("bool");
    expect(editorKind(m("jsonb"), text("{}"))).toBe("json");
    expect(editorKind(m("bytea"), NULL)).toBe("blob");
    expect(editorKind(m("text"), { t: "Blob", v: 3 })).toBe("blob");
    expect(editorKind(m("text"), text("a\nb"))).toBe("long");
    expect(editorKind(m("text"), text("short"))).toBeNull();
  });
});

describe("date conversion", () => {
  it("converts DB text to input values and back", () => {
    expect(toDateInput("1994-03-02")).toBe("1994-03-02");
    expect(toDatetimeInput("2026-10-18 01:38:34")).toBe("2026-10-18T01:38:34");
    expect(toDatetimeInput("2026-10-18 01:38:34.123456")).toBe("2026-10-18T01:38:34.123");
    expect(toDatetimeInput("2026-10-18 01:38")).toBe("2026-10-18T01:38:00");
    expect(toDatetimeInput("not a date")).toBe("");
    expect(fromDatetimeInput("2026-01-02T03:04:05")).toBe("2026-01-02 03:04:05");
  });
});
