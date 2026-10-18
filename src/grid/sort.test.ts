import { describe, expect, it } from "vitest";
import { NULL, text } from "../api/types";
import { clientOrder, cycleSort, orderByText, sortSuffix } from "./sort";

const cols = [
  { name: "id", type_name: "INT4" },
  { name: "Name", type_name: "TEXT" },
];

describe("sort", () => {
  it("cycles asc → desc → none", () => {
    let k = cycleSort([], 0, false);
    expect(k).toEqual([{ col: 0, desc: false }]);
    k = cycleSort(k, 0, false);
    expect(k).toEqual([{ col: 0, desc: true }]);
    expect(cycleSort(k, 0, false)).toEqual([]);
    expect(cycleSort(k, 1, false)).toEqual([{ col: 1, desc: false }]);
  });

  it("supports shift multi-sort", () => {
    let k = cycleSort([], 1, false);
    k = cycleSort(k, 0, true);
    expect(k).toEqual([{ col: 1, desc: false }, { col: 0, desc: false }]);
    k = cycleSort(k, 1, true);
    expect(k).toEqual([{ col: 1, desc: true }, { col: 0, desc: false }]);
    expect(orderByText(k, cols, "postgres")).toBe('"Name" DESC, "id"');
    expect(orderByText(k, cols, "mysql")).toBe("`Name` DESC, `id`");
    expect(sortSuffix(k, 1)).toBe(" ▼1");
    k = cycleSort(k, 1, true);
    expect(k).toEqual([{ col: 0, desc: false }]);
  });

  it("sorts a page on the client with nulls last", () => {
    const rows = [
      [text("10"), text("b")],
      [text("9"), NULL],
      [NULL, text("a")],
      [text("100"), text("c")],
    ];
    expect(clientOrder(rows, [{ col: 0, desc: false }], cols)).toEqual([1, 0, 3, 2]);
    expect(clientOrder(rows, [{ col: 0, desc: true }], cols)).toEqual([3, 0, 1, 2]);
    expect(clientOrder(rows, [{ col: 1, desc: false }], cols)).toEqual([2, 0, 3, 1]);
  });
});
