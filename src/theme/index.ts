import { useSyncExternalStore } from "react";
import type { Theme } from "@glideapps/glide-data-grid";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

export type Scheme = "light" | "dark";

const mq = window.matchMedia("(prefers-color-scheme: dark)");
const subscribe = (cb: () => void) => {
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};

export function useColorScheme(): Scheme {
  return useSyncExternalStore(subscribe, () => (mq.matches ? "dark" : "light"));
}

// Glide는 canvas에 그리므로 CSS 변수 대신 실제 색을 넘긴다.
const font = '"Segoe UI", system-ui, sans-serif';
export const gridThemes: Record<Scheme, Partial<Theme>> = {
  light: {
    accentColor: "#3574f0",
    accentLight: "rgba(53, 116, 240, 0.15)",
    textDark: "#1f2328",
    textMedium: "#5b616b",
    textLight: "#8a9099",
    textBubble: "#1f2328",
    bgIconHeader: "#5b616b",
    fgIconHeader: "#ffffff",
    textHeader: "#1f2328",
    textHeaderSelected: "#ffffff",
    bgCell: "#ffffff",
    bgCellMedium: "#f7f8fa",
    bgHeader: "#f5f6f8",
    bgHeaderHasFocus: "#e4e7eb",
    bgHeaderHovered: "#ebedf0",
    bgBubble: "#ebedf0",
    bgBubbleSelected: "#ffffff",
    bgSearchResult: "#fff3b0",
    borderColor: "rgba(0, 0, 0, 0.09)",
    horizontalBorderColor: "rgba(0, 0, 0, 0.06)",
    drilldownBorder: "rgba(0, 0, 0, 0.2)",
    linkColor: "#3574f0",
    cellHorizontalPadding: 8,
    cellVerticalPadding: 3,
    headerFontStyle: "600 12px",
    baseFontStyle: "12.5px",
    fontFamily: font,
    editorFontSize: "12.5px",
    lineHeight: 1.4,
  },
  dark: {
    accentColor: "#3574f0",
    accentLight: "rgba(53, 116, 240, 0.25)",
    textDark: "#dfe1e5",
    textMedium: "#a8abb2",
    textLight: "#6f737a",
    textBubble: "#dfe1e5",
    bgIconHeader: "#a8abb2",
    fgIconHeader: "#1e1f22",
    textHeader: "#dfe1e5",
    textHeaderSelected: "#ffffff",
    bgCell: "#1e1f22",
    bgCellMedium: "#232427",
    bgHeader: "#2b2d30",
    bgHeaderHasFocus: "#393b40",
    bgHeaderHovered: "#33353a",
    bgBubble: "#393b40",
    bgBubbleSelected: "#2b2d30",
    bgSearchResult: "#5c4b13",
    borderColor: "rgba(255, 255, 255, 0.09)",
    horizontalBorderColor: "rgba(255, 255, 255, 0.05)",
    drilldownBorder: "rgba(255, 255, 255, 0.2)",
    linkColor: "#548af7",
    cellHorizontalPadding: 8,
    cellVerticalPadding: 3,
    headerFontStyle: "600 12px",
    baseFontStyle: "12.5px",
    fontFamily: font,
    editorFontSize: "12.5px",
    lineHeight: 1.4,
  },
};

/** 셀 상태별 배경 (편집/추가/삭제) */
export const cellColors: Record<Scheme, { edit: string; insert: string; delete: string; muted: string; errorRow: string }> = {
  light: { edit: "#dbe8ff", insert: "#dcf3df", delete: "#fbe0e0", muted: "#9aa0a8", errorRow: "#ffd2d2" },
  dark: { edit: "#25324d", insert: "#253a2a", delete: "#4a2a2c", muted: "#6f737a", errorRow: "#5a1f24" },
};

const editorBase = (dark: boolean) =>
  EditorView.theme(
    {
      "&": { fontSize: "13px", backgroundColor: dark ? "#1e1f22" : "#ffffff", color: dark ? "#bcbec4" : "#1f2328" },
      ".cm-content": { fontFamily: 'var(--mono)', caretColor: dark ? "#ced0d6" : "#000" },
      ".cm-scroller": { fontFamily: 'var(--mono)' },
      ".cm-gutters": { backgroundColor: dark ? "#1e1f22" : "#ffffff", color: dark ? "#4b5059" : "#adb1b8", border: "none" },
      ".cm-activeLine": { backgroundColor: dark ? "#26282e" : "#f5f8fe" },
      ".cm-activeLineGutter": { backgroundColor: dark ? "#26282e" : "#f5f8fe", color: dark ? "#a1a3ab" : "#5b616b" },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
        backgroundColor: dark ? "#214283 !important" : "#a6d2ff !important",
      },
      ".cm-tooltip": { backgroundColor: dark ? "#2b2d30" : "#ffffff", border: `1px solid ${dark ? "#43454a" : "#d8dbe0"}` },
      ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: dark ? "#2e436e" : "#d6e4ff", color: "inherit" },
      ".cm-matchingBracket": { backgroundColor: dark ? "#3b514d" : "#d7ecd7" },
      ".cm-running-stmt": { backgroundColor: dark ? "rgba(53,116,240,0.12)" : "rgba(53,116,240,0.08)" },
    },
    { dark },
  );

const lightHl = HighlightStyle.define([
  { tag: t.keyword, color: "#0033b3", fontWeight: "600" },
  { tag: [t.string, t.special(t.string)], color: "#067d17" },
  { tag: t.number, color: "#1750eb" },
  { tag: [t.lineComment, t.blockComment], color: "#8c8c8c", fontStyle: "italic" },
  { tag: [t.typeName, t.standard(t.name)], color: "#871094" },
  { tag: t.operator, color: "#1f2328" },
  { tag: [t.special(t.name), t.quote], color: "#9e880d" },
  { tag: t.bool, color: "#0033b3" },
  { tag: t.null, color: "#0033b3" },
]);

const darkHl = HighlightStyle.define([
  { tag: t.keyword, color: "#cf8e6d" },
  { tag: [t.string, t.special(t.string)], color: "#6aab73" },
  { tag: t.number, color: "#2aacb8" },
  { tag: [t.lineComment, t.blockComment], color: "#7a7e85", fontStyle: "italic" },
  { tag: [t.typeName, t.standard(t.name)], color: "#c77dbb" },
  { tag: t.operator, color: "#bcbec4" },
  { tag: [t.special(t.name), t.quote], color: "#b3ae60" },
  { tag: t.bool, color: "#cf8e6d" },
  { tag: t.null, color: "#cf8e6d" },
]);

export const editorThemes: Record<Scheme, Extension> = {
  light: [editorBase(false), syntaxHighlighting(lightHl)],
  dark: [editorBase(true), syntaxHighlighting(darkHl)],
};
