import { describe, expect, it } from "vitest";
import { qualified, quoteIdent, quoteLiteral } from "./quote";

// Rust db/edit.rs의 quote_ident/table_ref 테스트와 같은 입력·결과여야 한다
describe("quote", () => {
  it("quotes identifiers per dialect", () => {
    expect(quoteIdent("mysql", "a`b")).toBe("`a``b`");
    expect(quoteIdent("postgres", 'a"b')).toBe('"a""b"');
    expect(quoteIdent("sqlite", "a`b")).toBe('"a`b"');
  });
  it("drops the schema for SQLite", () => {
    expect(qualified("postgres", "public", "t")).toBe('"public"."t"');
    expect(qualified("mysql", "public", "t")).toBe("`public`.`t`");
    expect(qualified("sqlite", "main", "t")).toBe('"t"');
  });
  it("escapes literals (MySQL also escapes backslashes)", () => {
    const backslash = String.fromCharCode(92);
    expect(quoteLiteral("postgres", `it's ${backslash}`)).toBe(`'it''s ${backslash}'`);
    expect(quoteLiteral("mysql", `it's ${backslash}`)).toBe(`'it''s ${backslash}${backslash}'`);
  });
});
