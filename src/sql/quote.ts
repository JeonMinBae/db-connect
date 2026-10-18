import type { Driver } from "../api/types";

export const quoteIdent = (d: Driver, s: string) => (d === "mysql" ? "`" + s.replaceAll("`", "``") + "`" : '"' + s.replaceAll('"', '""') + '"');

export const qualified = (d: Driver, schema: string | null, table: string) =>
  (schema && d !== "sqlite" ? quoteIdent(d, schema) + "." : "") + quoteIdent(d, table);

/** SQL 문자열 리터럴 */
export const quoteLiteral = (d: Driver, s: string) => {
  let v = s.replaceAll("'", "''");
  if (d === "mysql") v = v.replaceAll("\\", "\\\\");
  return `'${v}'`;
};
