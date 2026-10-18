import { memo, useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import type { ColumnDef, IndexInfo, SqlConfig, TableStructure } from "../api/types";
import { canReorder, changeCount, changedFields, moveRow, newRow, orderChanged, revertRow, rowState, rowsOf, toDraft, TYPE_SUGGESTIONS, type Row } from "../structure/draft";
import { useConnections } from "../store/connections";
import { useTabs } from "../store/tabs";
import { useTree } from "../store/tree";
import { confirmDialog, toast } from "../store/ui";
import type { Scheme } from "../theme";
import { DdlPreview } from "./DdlPreview";

const STATE_LABEL = { added: "추가", deleted: "삭제", modified: "수정", same: "" };

/** 테이블 구조 탭 (S1: 컬럼 편집, 인덱스는 보기만) */
export const StructureTab = memo(function StructureTab(props: { tabId: string; cfg: SqlConfig; schema: string; table: string; scheme: Scheme; active: boolean }) {
  const { cfg, schema, table } = props;
  const [orig, setOrig] = useState<TableStructure | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [indexes, setIndexes] = useState<IndexInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<TableStructure | null>(null);
  const [loaded, setLoaded] = useState(false);
  const ro = cfg.read_only;
  const reorder = canReorder(cfg.driver) && !ro;
  const count = orig ? changeCount(orig, rows) : 0;

  const load = async () => {
    if (!(await useConnections.getState().connect(cfg.id))) return;
    try {
      const [s, ix] = await Promise.all([api.tableStructure(cfg.id, schema, table), api.listIndexes(cfg.id, schema, table)]);
      if (!s.columns.length) throw new Error(`테이블 ${schema}.${table}을(를) 찾을 수 없습니다.`);
      setOrig(s);
      setRows(rowsOf(s));
      setIndexes(ix);
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

  const update = (key: string, patch: Partial<ColumnDef>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, col: { ...r.col, ...patch } } : r)));
  const remove = (key: string) => setRows((rs) => rs.flatMap((r) => (r.key !== key ? [r] : r.col.orig_name === null ? [] : [{ ...r, deleted: true }])));

  const startApply = async () => {
    if (!orig) return;
    const { tabs, dirty, activate } = useTabs.getState();
    const pending = tabs.find((t) => t.kind === "table" && t.connId === cfg.id && t.schema === schema && t.table === table && dirty[t.id]?.edit);
    if (pending) {
      toast("같은 테이블의 데이터 탭에 제출하지 않은 변경이 있습니다. 먼저 제출하거나 취소하세요.", "error");
      activate(pending.id);
      return;
    }
    if (!(await useConnections.getState().connect(cfg.id))) return;
    setPreview(toDraft(orig, rows));
  };

  /** 구조가 바뀌었다: 다시 읽고 트리·자동완성·데이터 탭에 알린다 */
  const changed = async () => {
    await load();
    await useTree.getState().structureChanged(cfg.id, schema, table);
    await useConnections.getState().refreshSnapshot(cfg.id);
  };

  const types = `types-${props.tabId}`;
  const reordered = orig ? orderChanged(orig, rows) : false;

  return (
    <>
      <div className="toolbar">
        <button className="icon" title="다시 읽기" onClick={() => void reload()}>
          ⟳
        </button>
        {!ro && (
          <>
            <button disabled={!orig} onClick={() => setRows((rs) => [...rs, newRow()])}>
              ＋ 컬럼
            </button>
            <button disabled={!count} onClick={() => orig && setRows(rowsOf(orig))}>
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
        {orig && (
          <>
            <h4>컬럼</h4>
            <datalist id={types}>
              {TYPE_SUGGESTIONS[cfg.driver].map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
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
                {rows.map((r, i) => {
                  const st = rowState(orig, r);
                  const ch = st === "modified" ? changedFields(orig, r) : new Set<string>();
                  const lock = ro || r.deleted || r.col.generated;
                  const cls = (f: string) => (ch.has(f) ? "changed" : undefined);
                  const isPk = r.col.orig_name !== null && orig.primary_key.includes(r.col.orig_name);
                  return (
                    <tr key={r.key} className={`st-${st}`}>
                      {reorder && (
                        <td className="nowrap">
                          <button className="icon" title="위로" disabled={i === 0} onClick={() => setRows((rs) => moveRow(rs, r.key, -1))}>
                            ↑
                          </button>
                          <button className="icon" title="아래로" disabled={i === rows.length - 1} onClick={() => setRows((rs) => moveRow(rs, r.key, 1))}>
                            ↓
                          </button>
                        </td>
                      )}
                      <td title={isPk ? "기본키" : r.col.generated ? "생성 컬럼 (SQL로 직접 바꿔 주세요)" : undefined}>{isPk ? "🔑" : r.col.generated ? "ƒ" : ""}</td>
                      <td>
                        <input className={cls("name")} value={r.col.name} disabled={lock} placeholder="이름" onChange={(e) => update(r.key, { name: e.target.value })} />
                      </td>
                      <td>
                        <input
                          className={cls("full_type")}
                          list={types}
                          value={r.col.full_type}
                          disabled={lock}
                          placeholder="타입"
                          onChange={(e) => update(r.key, { full_type: e.target.value })}
                        />
                      </td>
                      <td className="center">
                        <input type="checkbox" className={cls("nullable")} checked={r.col.nullable} disabled={lock} onChange={(e) => update(r.key, { nullable: e.target.checked })} />
                      </td>
                      <td>
                        <input
                          className={cls("default")}
                          value={r.col.default ?? ""}
                          disabled={lock}
                          placeholder="없음"
                          title="SQL 식입니다. 문자열은 '따옴표'로 감싸세요."
                          onChange={(e) => update(r.key, { default: e.target.value === "" ? null : e.target.value })}
                        />
                      </td>
                      <td className="center">
                        <input
                          type="checkbox"
                          className={cls("auto_increment")}
                          checked={r.col.auto_increment}
                          disabled={lock}
                          onChange={(e) => update(r.key, { auto_increment: e.target.checked })}
                        />
                      </td>
                      <td className="nowrap">
                        <span className="state">{STATE_LABEL[st]}</span>
                        {!ro && st !== "same" && st !== "added" && (
                          <button className="icon" title="되돌리기" onClick={() => setRows((rs) => revertRow(orig, rs, r.key))}>
                            ↺
                          </button>
                        )}
                        {!ro && !r.deleted && (
                          <button className="icon" title="삭제" onClick={() => remove(r.key)}>
                            ✕
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="hint">
              기본값은 SQL 식입니다(문자열은 '따옴표'). 기본키·인덱스·제약 편집은 아직 지원하지 않습니다.
              {cfg.driver === "postgres" && " PostgreSQL은 컬럼 순서를 바꿀 수 없어 새 컬럼은 맨 뒤에 추가됩니다."}
              {cfg.driver === "sqlite" && " SQLite는 컬럼 추가·삭제·이름 변경 외의 변경을 테이블을 다시 만들어 처리합니다."}
            </div>

            <h4>인덱스</h4>
            {indexes.length === 0 ? (
              <div className="hint">인덱스 없음</div>
            ) : (
              <table className="structure-grid">
                <thead>
                  <tr>
                    <th>이름</th>
                    <th>컬럼</th>
                    <th>종류</th>
                  </tr>
                </thead>
                <tbody>
                  {indexes.map((ix) => (
                    <tr key={ix.name}>
                      <td>{ix.name}</td>
                      <td>{ix.columns.join(", ")}</td>
                      <td>{ix.primary ? "PK" : ix.unique ? "UNIQUE" : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
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
