import type { Extension } from "@codemirror/state";

// 언어 패키지는 동적 import 로 나눠서, 해당 확장자 파일을 열 때만 내려받는다
const LOADERS: Record<string, () => Promise<Extension>> = {
  json: () => import("@codemirror/lang-json").then((m) => m.json()),
  js: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  ts: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true })),
  html: () => import("@codemirror/lang-html").then((m) => m.html()),
  css: () => import("@codemirror/lang-css").then((m) => m.css()),
  xml: () => import("@codemirror/lang-xml").then((m) => m.xml()),
  yml: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),
  md: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
  py: () => import("@codemirror/lang-python").then((m) => m.python()),
  sql: () => import("@codemirror/lang-sql").then((m) => m.sql()),
};
const ALIAS: Record<string, string> = { jsx: "js", mjs: "js", cjs: "js", tsx: "ts", htm: "html", yaml: "yml", markdown: "md", svg: "xml" };

/** ".env" 처럼 점으로 시작만 하는 이름은 확장자가 없는 것으로 본다 */
export function languageKey(fileName: string): string | null {
  const i = fileName.lastIndexOf(".");
  const ext = i > 0 ? fileName.slice(i + 1).toLowerCase() : "";
  const k = ALIAS[ext] ?? ext;
  return Object.hasOwn(LOADERS, k) ? k : null;
}

export const loadLanguage = (fileName: string): Promise<Extension> => {
  const k = languageKey(fileName);
  return k ? LOADERS[k]() : Promise.resolve([]);
};
