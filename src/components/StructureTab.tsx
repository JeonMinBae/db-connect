import { memo, useEffect, useState, type ReactNode } from "react";
import { api, errorMessage } from "../api";
import type { CheckDef, ColumnDef, ForeignKeyDef, IndexDef, SqlConfig, TableStructure } from "../api/types";
import {
  canReorder,
  changedFields,
  draftChangeCount,
  draftOf,
  entryState,
  FK_ACTIONS,
  moveRow,
  newEntry,
  newRow,
  orderChanged,
  parseList,
  pkChanged,
  removeEntry,
  renameColumnRefs,
  revertEntry,
  revertRow,
  rowState,
  toStructure,
  TYPE_SUGGESTIONS,
  type Draft,
  type Entry,
  type RowState,
} from "../structure/draft";
import { useConnections } from "../store/connections";
import { useTabs } from "../store/tabs";
import { useTree } from "../store/tree";
import { confirmDialog, toast } from "../store/ui";
import type { Scheme } from "../theme";
import { DdlPreview } from "./DdlPreview";

const STATE_LABEL: Record<RowState, string> = { added: "추가", deleted: "삭제", modified: "수정", same: "" };

/** 쉼표로 나눈 컬럼 목록 입력. 입력 중인 글자(끝의 쉼표 등)를 지우지 않도록 자체 텍스트를 둔다. */
function ListInput(props: { value: string[]; onChange: (v: string[]) => void; disabled?: boolean; placeholder?: string; list?: string }) {
  const [text, setText] = useState(props.value.join(", "));
  useEffect(() => {
    if (parseList(text).join("\u0000") !== props.value.join("\u0000")) setText(props.value.join(", "));
  }, [props.value]);
  return (
    <input
      value={text}
      disabled={props.disabled}
      placeholder={props.placeholder}
      list={props.list}
      onChange={(e) => {
        setText(e.target.value);
        props.onChange(parseList(e.target.value));
      }}
    />
  );
}

/** 항목 줄 끝의 상태·되돌리기·삭제 */
function RowActions(props: { state: RowState; ro: boolean; deleted: boolean; onRevert: () => void; onRemove: () => void }) {
  return (
    <td className="nowrap">
      <span className="state">{STATE_LABEL[props.state]}</span>
      {!props.ro && props.state !== "same" && props.state !== "added" && (
        <button className="icon" title="되돌리기" onClick={props.onRevert}>
          ↺
        </button>
      )}
      {!props.ro && !props.deleted && (
        <button className="icon" title="삭제" onClick={props.onRemove}>
          ✕
        </button>
      )}
    </td>
  );
}

function Section(props: { title: string; onAdd?: () => void; addLabel?: string; children: ReactNode }) {
  return (
    <>
      <h4>
        {props.title}
        {props.onAdd && (
          <button className="icon add" onClick={props.onAdd}>
            ＋ {props.addLabel}
          </button>
        )}
      </h4>
      {props.children}
    </>
  );
}

/** 테이블 구조 탭: 컬럼 · 기본키 · 인덱스 · 외래 키 · CHECK */
export const StructureTab = memo(function StructureTab(props: { tabId: string; cfg: SqlConfig; schema: string; table: string; scheme: Scheme; active: boolean }) {
  const { cfg, schema, table } = props;
  const [orig, setOrig] = useState<TableStructure | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<TableStructure | null>(null);
  const [loaded, setLoaded] = useState(false);
  const ro = cfg.read_only;
  const reorder = canReorder(cfg.driver) && !ro;
  const count = orig && draft ? draftChangeCount(orig, draft) : 0;

  const load = async () => {
    if (!(await useConnections.getState().connect(cfg.id))) return;
    try {
      const s = await api.tableStructure(cfg.id, schema, table);
      if (!s.columns.length) throw new Error(`테이블 ${schema}.${table}을(를) 찾을 수 없습니다.`);
      setOrig(s);
      setDraft(draftOf(s));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  useEffect(() => {
    if (props.active && !loaded) {
      setLoaded(true);
      void load();
    }
  }, [props.active]);

  useEffect(() => {
    useTabs.getState().setDirty(props.tabId, "edit", count ? `적용하지 않은 구조 변경 ${count}개가 있습니다.` : null);
  }, [count]);
  useEffect(() => () => useTabs.getState().setDirty(props.tabId, "edit", null), []);

  const reload = async () => {
    if (count && !(await confirmDialog({ title: "변경 버리기", body: "적용하지 않은 구조 변경이 버려집니다.", okLabel: "다시 읽기", danger: true }))) return;
    await load();
  };

  const edit = (f: (d: Draft) => Draft) => setDraft((d) => (d ? f(d) : d));
  const updateCol = (key: string, patch: Partial<ColumnDef>) =>
    edit((d) => {
      const before = d.columns.find((r) => r.key === key)?.col.name ?? "";
      const next = { ...d, columns: d.columns.map((r) => (r.key === key ? { ...r, col: { ...r.col, ...patch } } : r)) };
      return patch.name !== undefined ? renameColumnRefs(next, before, patch.name) : next;
    });
  const removeCol = (key: string) => edit((d) => ({ ...d, columns: d.columns.flatMap((r) => (r.key !== key ? [r] : r.col.orig_name === null ? [] : [{ ...r, deleted: true }])) }));
  const updateEntry = <K extends "indexes" | "fks" | "checks">(list: K, key: string, patch: Partial<Draft[K][number]["def"]>) =>
    edit((d) => ({ ...d, [list]: (d[list] as Entry<object>[]).map((e) => (e.key === key ? { ...e, def: { ...e.def, ...patch } } : e)) }));

  const startApply = async () => {
    if (!orig || !draft) return;
    const { tabs, dirty, activate } = useTabs.getState();
    const pending = tabs.find((t) => t.kind === "table" && t.connId === cfg.id && t.schema === schema && t.table === table && dirty[t.id]?.edit);
    if (pending) {
      toast("같은 테이블의 데이터 탭에 제출하지 않은 변경이 있습니다. 먼저 제출하거나 취소하세요.", "error");
      activate(pending.id);
      return;
    }
    if (!(await useConnections.getState().connect(cfg.id))) return;
    setPreview(toStructure(orig, draft));
  };

  /** 구조가 바뀌었다: 다시 읽고 트리·자동완성·데이터 탭에 알린다 */
  const changed = async () => {
    await load();
    await useTree.getState().structureChanged(cfg.id, schema, table);
    await useConnections.getState().refreshSnapshot(cfg.id);
  };

  const types = `types-${props.tabId}`;
  const colNames = `cols-${props.tabId}`;
  const reordered = orig && draft ? orderChanged(orig, draft.columns) : false;
  const liveCols = draft?.columns.filter((r) => !r.deleted).map((r) => r.col.name) ?? [];
  const lite = cfg.driver === "sqlite";

  return (
    <>
      <div className="toolbar">
        <button className="icon" title="다시 읽기" onClick={() => void reload()}>
          ⟳
        </button>
        {!ro && (
          <>
            <button disabled={!count} onClick={() => orig && setDraft(draftOf(orig))}>
              모두 되돌리기
            </button>
            <button className="primary" disabled={!count} onClick={() => void startApply()}>
              적용…
            </button>
          </>
        )}
        {count > 0 && <span className="label">{count}개 변경{reordered ? " (순서 포함)" : ""}</span>}
        <span className="spacer" />
        <span className="label">
          {schema}.{table}
        </span>
        {ro && <span className="badge">READ ONLY</span>}
        <span className="label">{cfg.name}</span>
      </div>
      <div className="structure">
        {error && <div className="message error" style={{ flex: "none" }}>{error}</div>}
        {orig && draft && (
          <>
            <datalist id={types}>
              {TYPE_SUGGESTIONS[cfg.driver].map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
            <datalist id={colNames}>
              {liveCols.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>

            <Section title="컬럼" addLabel="컬럼" onAdd={ro ? undefined : () => edit((d) => ({ ...d, columns: [...d.columns, newRow()] }))}>
              <table className="structure-grid">
                <thead>
                  <tr>
                    {reorder && <th />}
                    <th />
                    <th>이름</th>
                    <th>타입</th>
                    <th title="NULL 허용">NULL</th>
                    <th>기본값</th>
                    <th title="자동 증가">자동 증가</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {draft.columns.map((r, i) => {
                    const st = rowState(orig, r);
                    const ch = st === "modified" ? changedFields(orig, r) : new Set<string>();
                    const lock = ro || r.deleted || r.col.generated;
                    const cls = (f: string) => (ch.has(f) ? "changed" : undefined);
                    const isPk = draft.pk.includes(r.col.name);
                    return (
                      <tr key={r.key} className={`st-${st}`}>
                        {reorder && (
                          <td className="nowrap">
                            <button className="icon" title="위로" disabled={i === 0} onClick={() => edit((d) => ({ ...d, columns: moveRow(d.columns, r.key, -1) }))}>
                              ↑
                            </button>
                            <button className="icon" title="아래로" disabled={i === draft.columns.length - 1} onClick={() => edit((d) => ({ ...d, columns: moveRow(d.columns, r.key, 1) }))}>
                              ↓
                            </button>
                          </td>
                        )}
                        <td title={isPk ? "기본키" : r.col.generated ? "생성 컬럼 (SQL로 직접 바꿔 주세요)" : undefined}>{isPk ? "🔑" : r.col.generated ? "ƒ" : ""}</td>
                        <td>
                          <input className={cls("name")} value={r.col.name} disabled={lock} placeholder="이름" onChange={(e) => updateCol(r.key, { name: e.target.value })} />
                        </td>
                        <td>
                          <input className={cls("full_type")} list={types} value={r.col.full_type} disabled={lock} placeholder="타입" onChange={(e) => updateCol(r.key, { full_type: e.target.value })} />
                        </td>
                        <td className="center">
                          <input type="checkbox" className={cls("nullable")} checked={r.col.nullable} disabled={lock} onChange={(e) => updateCol(r.key, { nullable: e.target.checked })} />
                        </td>
                        <td>
                          <input
                            className={cls("default")}
                            value={r.col.default ?? ""}
                            disabled={lock}
                            placeholder="없음"
                            title="SQL 식입니다. 문자열은 '따옴표'로 감싸세요."
                            onChange={(e) => updateCol(r.key, { default: e.target.value === "" ? null : e.target.value })}
                          />
                        </td>
                        <td className="center">
                          <input type="checkbox" className={cls("auto_increment")} checked={r.col.auto_increment} disabled={lock} onChange={(e) => updateCol(r.key, { auto_increment: e.target.checked })} />
                        </td>
                        <RowActions
                          state={st}
                          ro={ro}
                          deleted={r.deleted}
                          onRevert={() => edit((d) => ({ ...d, columns: revertRow(orig, d.columns, r.key) }))}
                          onRemove={() => removeCol(r.key)}
                        />
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="hint">
                기본값은 SQL 식입니다(문자열은 '따옴표'). 컬럼 이름을 바꾸면 기본키·인덱스·외래 키의 컬럼 목록도 함께 바뀝니다.
                {cfg.driver === "postgres" && " PostgreSQL은 컬럼 순서를 바꿀 수 없어 새 컬럼은 맨 뒤에 추가됩니다."}
                {lite && " SQLite는 컬럼 추가·삭제·이름 변경과 인덱스 외의 변경을 테이블을 다시 만들어 처리합니다."}
              </div>
            </Section>

            <Section title="기본키">
              <table className="structure-grid">
                <tbody>
                  <tr className={pkChanged(orig, draft) ? "st-modified" : undefined}>
                    <td>
                      <ListInput value={draft.pk} disabled={ro} placeholder="없음 (컬럼, 컬럼…)" list={colNames} onChange={(pk) => edit((d) => ({ ...d, pk }))} />
                    </td>
                    <td className="nowrap">
                      {!ro && pkChanged(orig, draft) && (
                        <button className="icon" title="되돌리기" onClick={() => edit((d) => ({ ...d, pk: [...orig.primary_key] }))}>
                          ↺
                        </button>
                      )}
                    </td>
                  </tr>
                </tbody>
              </table>
            </Section>

            <Section
              title="인덱스"
              addLabel="인덱스"
              onAdd={ro ? undefined : () => edit((d) => ({ ...d, indexes: [...d.indexes, newEntry<IndexDef>({ orig_name: null, name: "", columns: [], unique: false, constraint: false, raw: null })] }))}
            >
              {draft.indexes.length === 0 ? (
                <div className="hint">인덱스 없음</div>
              ) : (
                <table className="structure-grid">
                  <thead>
                    <tr>
                      <th>이름</th>
                      <th>컬럼</th>
                      <th>UNIQUE</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {draft.indexes.map((e) => {
                      const st = entryState(orig.indexes, e);
                      const lock = ro || e.deleted || !!e.def.raw;
                      // SQLite UNIQUE 제약은 이름을 SQLite가 정한다
                      const fixedName = lock || (lite && e.def.constraint);
                      return (
                        <tr key={e.key} className={`st-${st}`}>
                          <td>
                            <input value={e.def.name} disabled={fixedName} placeholder="이름" onChange={(ev) => updateEntry("indexes", e.key, { name: ev.target.value })} />
                          </td>
                          <td>
                            {e.def.raw ? (
                              <span className="raw" title="식·부분 인덱스는 그대로 두거나 삭제만 할 수 있습니다">
                                {e.def.raw}
                              </span>
                            ) : (
                              <ListInput value={e.def.columns} disabled={lock} placeholder="컬럼, 컬럼…" list={colNames} onChange={(columns) => updateEntry("indexes", e.key, { columns })} />
                            )}
                          </td>
                          <td className="center">
                            <input type="checkbox" checked={e.def.unique} disabled={lock || e.def.constraint} onChange={(ev) => updateEntry("indexes", e.key, { unique: ev.target.checked })} />
                            {e.def.constraint && <span className="hint"> 제약</span>}
                          </td>
                          <RowActions
                            state={st}
                            ro={ro}
                            deleted={e.deleted}
                            onRevert={() => edit((d) => ({ ...d, indexes: revertEntry(orig.indexes, d.indexes, e.key) }))}
                            onRemove={() => edit((d) => ({ ...d, indexes: removeEntry(d.indexes, e.key) }))}
                          />
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </Section>

            <Section
              title="외래 키"
              addLabel="외래 키"
              onAdd={
                ro
                  ? undefined
                  : () =>
                      edit((d) => ({
                        ...d,
                        fks: [...d.fks, newEntry<ForeignKeyDef>({ orig_name: null, name: "", columns: [], ref_schema: null, ref_table: "", ref_columns: [], on_update: "NO ACTION", on_delete: "NO ACTION" })],
                      }))
              }
            >
              {draft.fks.length === 0 ? (
                <div className="hint">외래 키 없음</div>
              ) : (
                <table className="structure-grid">
                  <thead>
                    <tr>
                      <th>이름</th>
                      <th>컬럼</th>
                      <th>참조 테이블</th>
                      <th>참조 컬럼</th>
                      <th>ON UPDATE</th>
                      <th>ON DELETE</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {draft.fks.map((e) => {
                      const st = entryState(orig.foreign_keys, e);
                      const lock = ro || e.deleted;
                      const refName = (e.def.ref_schema ? e.def.ref_schema + "." : "") + e.def.ref_table;
                      return (
                        <tr key={e.key} className={`st-${st}`}>
                          <td>
                            <input className="narrow" value={e.def.name} disabled={lock || lite} placeholder={lite ? "" : "자동"} onChange={(ev) => updateEntry("fks", e.key, { name: ev.target.value })} />
                          </td>
                          <td>
                            <ListInput value={e.def.columns} disabled={lock} placeholder="컬럼, 컬럼…" list={colNames} onChange={(columns) => updateEntry("fks", e.key, { columns })} />
                          </td>
                          <td>
                            <input
                              value={refName}
                              disabled={lock}
                              placeholder={lite ? "테이블" : "[스키마.]테이블"}
                              onChange={(ev) => {
                                const v = ev.target.value;
                                const dot = lite ? -1 : v.indexOf(".");
                                updateEntry("fks", e.key, dot > 0 ? { ref_schema: v.slice(0, dot), ref_table: v.slice(dot + 1) } : { ref_schema: null, ref_table: v });
                              }}
                            />
                          </td>
                          <td>
                            <ListInput value={e.def.ref_columns} disabled={lock} placeholder={lite ? "비우면 기본키" : "컬럼, 컬럼…"} onChange={(ref_columns) => updateEntry("fks", e.key, { ref_columns })} />
                          </td>
                          {(["on_update", "on_delete"] as const).map((f) => (
                            <td key={f}>
                              <select value={e.def[f]} disabled={lock} onChange={(ev) => updateEntry("fks", e.key, { [f]: ev.target.value })}>
                                {FK_ACTIONS.map((a) => (
                                  <option key={a}>{a}</option>
                                ))}
                              </select>
                            </td>
                          ))}
                          <RowActions
                            state={st}
                            ro={ro}
                            deleted={e.deleted}
                            onRevert={() => edit((d) => ({ ...d, fks: revertEntry(orig.foreign_keys, d.fks, e.key) }))}
                            onRemove={() => edit((d) => ({ ...d, fks: removeEntry(d.fks, e.key) }))}
                          />
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </Section>

            <Section
              title="CHECK 제약"
              addLabel="CHECK"
              onAdd={ro ? undefined : () => edit((d) => ({ ...d, checks: [...d.checks, newEntry<CheckDef>({ orig_name: null, name: "", expr: "" })] }))}
            >
              {orig.checks_unsupported && <div className="hint">이 서버는 CHECK 제약을 조회할 수 없습니다(MySQL 8.0.16 / MariaDB 10.2 미만에서는 CHECK가 강제되지 않습니다).</div>}
              {draft.checks.length === 0 ? (
                <div className="hint">CHECK 제약 없음</div>
              ) : (
                <table className="structure-grid">
                  <thead>
                    <tr>
                      <th>이름</th>
                      <th>식</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {draft.checks.map((e) => {
                      const st = entryState(orig.checks, e);
                      const lock = ro || e.deleted;
                      return (
                        <tr key={e.key} className={`st-${st}`}>
                          <td>
                            <input className="narrow" value={e.def.name} disabled={lock} placeholder="자동" onChange={(ev) => updateEntry("checks", e.key, { name: ev.target.value })} />
                          </td>
                          <td>
                            <input className="wide" value={e.def.expr} disabled={lock} placeholder="예: price >= 0" onChange={(ev) => updateEntry("checks", e.key, { expr: ev.target.value })} />
                          </td>
                          <RowActions
                            state={st}
                            ro={ro}
                            deleted={e.deleted}
                            onRevert={() => edit((d) => ({ ...d, checks: revertEntry(orig.checks, d.checks, e.key) }))}
                            onRemove={() => edit((d) => ({ ...d, checks: removeEntry(d.checks, e.key) }))}
                          />
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </Section>
          </>
        )}
      </div>
      {preview && orig && (
        <DdlPreview
          cfg={cfg}
          scheme={props.scheme}
          schema={schema}
          table={table}
          original={orig}
          draft={preview}
          onClose={() => setPreview(null)}
          onPartial={() => void changed()}
          onDone={() => {
            setPreview(null);
            toast("구조를 바꿨습니다.");
            void changed();
          }}
        />
      )}
    </>
  );
});
