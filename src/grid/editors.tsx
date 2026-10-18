import { useEffect, useRef, useState } from "react";
import type { GridCell, ProvideEditorCallbackResult } from "@glideapps/glide-data-grid";
import type { Cell, ColumnMeta } from "../api/types";
import { fmtBytes } from "./cells";

/** 셀 객체에 실어 보내는 편집 문맥 (provideEditor는 위치를 모르므로) */
export interface EditCtx {
  meta: ColumnMeta;
  value: Cell;
  nullable: boolean;
  readonly: boolean;
  apply: (v: Cell) => void;
  /** 바이너리 셀 파일 입출력. 키 계산 비용 때문에 편집기를 열 때만 호출한다 */
  blob?: () => { save: () => void; load: (() => void) | null } | undefined;
}

export type CellWithCtx = GridCell & { __ctx?: EditCtx };

type Kind = "date" | "datetime" | "enum" | "bool" | "json" | "long" | "blob";

const BINARY = /^(bytea|blob|tinyblob|mediumblob|longblob|binary|varbinary)$/i;

export function editorKind(meta: ColumnMeta, value: Cell): Kind | null {
  const t = meta.data_type.toLowerCase();
  const full = meta.full_type.toLowerCase();
  if (value.t === "Blob" || BINARY.test(t)) return "blob";
  if (meta.enum_values?.length) return "enum";
  if (t === "bool" || t === "boolean" || full === "tinyint(1)") return "bool";
  if (t === "json" || t === "jsonb") return "json";
  if (t === "date") return "date";
  // 시간대가 있는 타입은 오프셋을 잃지 않도록 텍스트로 편집한다
  if (/^(timestamp|timestamp without time zone|datetime)$/.test(t) || /^(timestamp|datetime)(\(\d\))?$/.test(full)) return "datetime";
  if (value.t === "Text" && (value.v.length > 200 || /[\r\n]/.test(value.v))) return "long";
  return null;
}

// ---- 값 변환 ----
export const toDateInput = (v: string) => (/^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : "");
export function toDatetimeInput(v: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(\.\d{1,3})?/.exec(v);
  return m ? `${m[1]}T${m[2].length === 5 ? m[2] + ":00" : m[2]}${m[3] ?? ""}` : "";
}
export const fromDatetimeInput = (v: string) => v.replace("T", " ");

const boolLabel = (v: string) => (v === "t" || v === "1" ? `true (${v})` : v === "f" || v === "0" ? `false (${v})` : v);

// ---- 공통 UI ----
const box: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6, padding: 8, minWidth: 240, font: "13px var(--font)", color: "var(--fg)" };
const row: React.CSSProperties = { display: "flex", gap: 6, alignItems: "center", justifyContent: "flex-end" };

function Buttons(props: { ctx: EditCtx; onSave?: () => void; saveDisabled?: boolean; close: () => void }) {
  return (
    <div style={row}>
      {props.ctx.nullable && !props.ctx.readonly && (
        <button
          onClick={() => {
            props.ctx.apply({ t: "Null" });
            props.close();
          }}
        >
          NULL
        </button>
      )}
      <span style={{ flex: 1 }} />
      <button onClick={props.close}>취소</button>
      {props.onSave && (
        <button className="primary" disabled={props.saveDisabled || props.ctx.readonly} onClick={props.onSave}>
          적용
        </button>
      )}
    </div>
  );
}

type EditorProps = { value: GridCell; onFinishedEditing: (v?: GridCell) => void };
const ctxOf = (p: EditorProps) => (p.value as CellWithCtx).__ctx!;
const textOf = (c: Cell) => (c.t === "Text" ? c.v : "");

function InputEditor(p: EditorProps & { type: "date" | "datetime-local" }) {
  const ctx = ctxOf(p);
  const init = p.type === "date" ? toDateInput(textOf(ctx.value)) : toDatetimeInput(textOf(ctx.value));
  const [v, setV] = useState(init);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const close = () => p.onFinishedEditing(undefined);
  const save = () => {
    // 바꾸지 않았으면 적용하지 않는다 (입력란이 표현하지 못하는 소수 초 자릿수를 지키기 위해)
    if (v && v !== init) ctx.apply({ t: "Text", v: p.type === "date" ? v : fromDatetimeInput(v) });
    close();
  };
  return (
    <div style={box} onKeyDown={(e) => (e.key === "Enter" ? save() : e.key === "Escape" ? close() : undefined)}>
      <input ref={ref} type={p.type} step={p.type === "datetime-local" ? 1 : undefined} value={v} onChange={(e) => setV(e.target.value)} disabled={ctx.readonly} />
      <Buttons ctx={ctx} onSave={save} saveDisabled={!v} close={close} />
    </div>
  );
}

function SelectEditor(p: EditorProps & { options: { value: string; label: string }[] }) {
  const ctx = ctxOf(p);
  const cur = ctx.value.t === "Null" ? "\u0000null" : textOf(ctx.value);
  const ref = useRef<HTMLSelectElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const close = () => p.onFinishedEditing(undefined);
  return (
    <div style={box} onKeyDown={(e) => e.key === "Escape" && close()}>
      <select
        ref={ref}
        size={Math.min(8, p.options.length + (ctx.nullable ? 1 : 0))}
        value={cur}
        disabled={ctx.readonly}
        onChange={(e) => {
          const v = e.target.value;
          ctx.apply(v === "\u0000null" ? { t: "Null" } : { t: "Text", v });
          close();
        }}
      >
        {ctx.nullable && <option value={"\u0000null"}>&lt;null&gt;</option>}
        {p.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Buttons ctx={{ ...ctx, nullable: false }} close={close} />
    </div>
  );
}

function TextAreaEditor(p: EditorProps & { json: boolean }) {
  const ctx = ctxOf(p);
  const original = textOf(ctx.value);
  // 원문 그대로 편집한다. JSON을 다시 직렬화하면 큰 정수의 정밀도가 사라질 수 있다
  const [v, setV] = useState(original);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  let error: string | null = null;
  if (p.json && v.trim()) {
    try {
      JSON.parse(v);
    } catch (e) {
      error = (e as Error).message;
    }
  }
  const close = () => p.onFinishedEditing(undefined);
  const save = () => {
    if (error) return;
    if (v !== original) ctx.apply({ t: "Text", v });
    close();
  };
  return (
    <div style={{ ...box, width: "100%" }} onKeyDown={(e) => (e.key === "Escape" ? close() : e.key === "Enter" && e.ctrlKey ? save() : undefined)}>
      <textarea
        ref={ref}
        value={v}
        readOnly={ctx.readonly}
        onChange={(e) => setV(e.target.value)}
        spellCheck={false}
        style={{ width: "100%", height: 260, fontFamily: "var(--mono)", resize: "vertical", whiteSpace: "pre" }}
      />
      {p.json && (
        <div style={{ ...row, justifyContent: "flex-start" }}>
          <button
            disabled={!!error || ctx.readonly}
            onClick={() => {
              try {
                setV(JSON.stringify(JSON.parse(v), null, 2));
              } catch {
                /* 오류는 아래에 표시된다 */
              }
            }}
          >
            포맷
          </button>
          <span className="hint" style={{ color: error ? "var(--danger)" : "var(--ok)" }}>
            {error ? `JSON 오류: ${error}` : "올바른 JSON"}
          </span>
        </div>
      )}
      <span className="hint">Ctrl+Enter 적용 · Esc 취소</span>
      <Buttons ctx={ctx} onSave={save} saveDisabled={!!error} close={close} />
    </div>
  );
}

function BlobEditor(p: EditorProps) {
  const ctx = ctxOf(p);
  const [blob] = useState(() => ctx.blob?.());
  const close = () => p.onFinishedEditing(undefined);
  const size = ctx.value.t === "Blob" ? fmtBytes(ctx.value.v) : ctx.value.t === "Null" ? "NULL" : "?";
  return (
    <div style={box} onKeyDown={(e) => e.key === "Escape" && close()}>
      <div>
        바이너리 값: <strong>{size}</strong>
      </div>
      {!blob && <div className="hint">키로 행을 찾을 수 없어 파일 입출력을 할 수 없습니다.</div>}
      <div style={{ ...row, justifyContent: "flex-start" }}>
        <button
          disabled={!blob || ctx.value.t !== "Blob"}
          onClick={() => {
            blob!.save();
            close();
          }}
        >
          파일로 저장…
        </button>
        <button
          disabled={!blob?.load}
          title={blob && !blob.load ? "저장되지 않은 행이거나 보류 중인 변경이 있습니다" : undefined}
          onClick={() => {
            blob!.load!();
            close();
          }}
        >
          파일에서 불러오기…
        </button>
      </div>
      <Buttons ctx={ctx} close={close} />
    </div>
  );
}

/** Glide provideEditor: 컬럼 메타에 맞는 편집기를 고른다 (없으면 기본 텍스트 편집기) */
export function provideEditor(cell: GridCell): ProvideEditorCallbackResult<GridCell> {
  const ctx = (cell as CellWithCtx).__ctx;
  if (!ctx) return undefined;
  const kind = editorKind(ctx.meta, ctx.value);
  const wrap = (editor: (p: EditorProps) => React.ReactElement, width?: number) => ({
    editor: editor as never,
    disablePadding: true,
    styleOverride: width ? { width, maxWidth: "90vw" } : undefined,
  });
  switch (kind) {
    case "date":
      return wrap((p) => <InputEditor {...p} type="date" />);
    case "datetime":
      return toDatetimeInput(textOf(ctx.value)) || ctx.value.t === "Null" ? wrap((p) => <InputEditor {...p} type="datetime-local" />) : undefined;
    case "enum":
      return wrap((p) => <SelectEditor {...p} options={ctx.meta.enum_values!.map((v) => ({ value: v, label: v }))} />);
    case "bool": {
      // PG bool은 t/f, MySQL tinyint(1)·SQLite BOOLEAN은 1/0으로 저장된다
      const opts = ctx.meta.data_type === "bool" ? ["t", "f"] : ["1", "0"];
      return wrap((p) => <SelectEditor {...p} options={opts.map((v) => ({ value: v, label: boolLabel(v) }))} />);
    }
    case "json":
      return wrap((p) => <TextAreaEditor {...p} json />, 540);
    case "long":
      return wrap((p) => <TextAreaEditor {...p} json={false} />, 540);
    case "blob":
      return wrap((p) => <BlobEditor {...p} />);
    default:
      return undefined;
  }
}
