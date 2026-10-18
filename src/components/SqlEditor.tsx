import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Compartment, EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as cmPlaceholder,
  type DecorationSet,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, redo } from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { MySQL, PostgreSQL, SQLite, sql, type SQLNamespace } from "@codemirror/lang-sql";
import type { Driver, SnapshotTable } from "../api/types";
import { editorThemes, type Scheme } from "../theme";

const DIALECTS = { postgres: PostgreSQL, mysql: MySQL, sqlite: SQLite };

export interface SqlEditorHandle {
  view: EditorView | null;
  /** 실행 중인 문장 범위를 표시한다 (null = 해제) */
  markRunning: (range: { from: number; to: number } | null) => void;
  focus: () => void;
  getText: () => string;
  setText: (text: string) => void;
}

/** 스냅샷을 lang-sql 네임스페이스 { schema: { table: [cols] } } 로 바꾼다 */
export function toNamespace(snap: SnapshotTable[] | undefined): SQLNamespace {
  const ns: Record<string, Record<string, string[]>> = {};
  for (const t of snap ?? []) (ns[t.schema] ??= {})[t.table] = t.columns;
  return ns;
}

const setRunning = StateEffect.define<{ from: number; to: number } | null>();
const runningField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects)
      if (e.is(setRunning)) {
        deco = e.value && e.value.to > e.value.from ? Decoration.set([Decoration.mark({ class: "cm-running-stmt" }).range(e.value.from, e.value.to)]) : Decoration.none;
      }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

interface Props {
  /** SQL 방언 (language를 주면 쓰지 않는다) */
  driver?: Driver;
  /** SQL 대신 쓸 언어 확장 (Redis·MongoDB 콘솔). 처음 만들 때 한 번만 읽는다. */
  language?: Extension;
  scheme: Scheme;
  initialText: string;
  snapshot?: SnapshotTable[];
  defaultSchema?: string;
  /** 이 테이블의 컬럼을 접두어 없이 자동완성한다 */
  defaultTable?: string;
  /** 문서가 바뀌면 호출. 문자열 변환 비용을 미루기 위해 텍스트 대신 getter를 넘긴다 */
  onChange?: (getText: () => string) => void;
  /** Mod-Enter */
  onRun?: (view: EditorView) => void;
  singleLine?: boolean;
  placeholder?: string;
  extraKeys?: { key: string; run: (view: EditorView) => boolean }[];
}

export const SqlEditor = forwardRef<SqlEditorHandle, Props>(function SqlEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const comps = useRef({ lang: new Compartment(), theme: new Compartment() });
  const propsRef = useRef(props);
  propsRef.current = props;

  const langExt = (): Extension => {
    const p = propsRef.current;
    // SQL이 아닌 모드: 언어 확장은 바깥에서 받는다 (Redis 명령 자동완성, mongosh 등)
    if (p.language) return p.language;
    return sql({
      dialect: DIALECTS[p.driver ?? "postgres"],
      upperCaseKeywords: true,
      schema: toNamespace(p.snapshot),
      defaultSchema: p.defaultSchema,
      defaultTable: p.defaultTable,
    });
  };

  useEffect(() => {
    const singleLine: Extension = props.singleLine
      ? EditorState.transactionFilter.of((tr) => (tr.newDoc.lines > 1 ? [] : tr))
      : [];
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: props.initialText,
        extensions: [
          props.singleLine ? [] : [lineNumbers(), highlightActiveLineGutter(), highlightActiveLine()],
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion({ activateOnTyping: true }),
          highlightSelectionMatches(),
          runningField,
          singleLine,
          props.placeholder ? cmPlaceholder(props.placeholder) : [],
          keymap.of([
            {
              key: "Mod-Enter",
              run: (v) => {
                propsRef.current.onRun?.(v);
                return true;
              },
            },
            ...closeBracketsKeymap,
            ...completionKeymap,
            // 키맵은 한 번만 만들어지므로 항상 최신 props의 핸들러를 부른다
            ...(props.extraKeys ?? []).map((k, i) => ({ key: k.key, run: (v: EditorView) => propsRef.current.extraKeys?.[i]?.run(v) ?? false })),
            ...searchKeymap,
            // 기본 키맵은 Windows에서 다시 실행을 Ctrl+Y에만 묶는다
            { key: "Mod-Shift-z", run: redo, preventDefault: true },
            ...historyKeymap,
            ...(props.singleLine ? [] : [indentWithTab]),
            ...defaultKeymap,
          ]),
          comps.current.lang.of(langExt()),
          comps.current.theme.of(editorThemes[props.scheme]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              const doc = u.state.doc;
              propsRef.current.onChange?.(() => doc.toString());
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => view.destroy();
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: comps.current.lang.reconfigure(langExt()) });
  }, [props.driver, props.snapshot, props.defaultSchema, props.defaultTable]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: comps.current.theme.reconfigure(editorThemes[props.scheme]) });
  }, [props.scheme]);

  useImperativeHandle(ref, () => ({
    get view() {
      return viewRef.current;
    },
    markRunning: (range) => viewRef.current?.dispatch({ effects: setRunning.of(range) }),
    focus: () => viewRef.current?.focus(),
    getText: () => viewRef.current?.state.doc.toString() ?? "",
    setText: (text: string) => {
      const v = viewRef.current;
      if (v) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
    },
  }));

  return <div ref={host} className="editor-host" style={props.singleLine ? { flex: 1, minHeight: 0 } : { height: "100%" }} />;
});
