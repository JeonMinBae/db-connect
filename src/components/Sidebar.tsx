import { useEffect, useState } from "react";
import { isSql, type ConnectionConfig } from "../api/types";
import { MongoTree, refreshMongoTree } from "./MongoTree";
import { RedisTree, refreshRedisTree } from "./RedisTree";
import { confirmLeave, useConnections } from "../store/connections";
import { useTabs } from "../store/tabs";
import { nodeKey, useTree } from "../store/tree";
import { confirmDialog } from "../store/ui";
import { DbLogo } from "./dbLogos";
import { Row, SubFolder } from "./TreeRow";
import { blankConfig, ConnectionDialog } from "./dialogs/ConnectionDialog";
import { showContextMenu } from "./ui";

const FILTER_THRESHOLD = 2000;

export function Sidebar() {
  const configs = useConnections((s) => s.configs);
  const [dialog, setDialog] = useState<{ cfg: ConnectionConfig; isNew: boolean } | null>(null);

  return (
    <>
      <div className="toolbar">
        <strong>접속</strong>
        <span className="spacer" />
        <button className="icon" title="새 접속" onClick={() => setDialog({ cfg: blankConfig(), isNew: true })}>
          ＋
        </button>
      </div>
      <div className="tree">
        {configs.length === 0 && <div className="empty" style={{ padding: 20 }}>＋ 버튼으로 접속을 추가하세요</div>}
        {configs.map((c) => (
          <ConnectionNode key={c.id} cfg={c} onEdit={(cfg, isNew) => setDialog({ cfg, isNew })} />
        ))}
      </div>
      {dialog && <ConnectionDialog initial={dialog.cfg} isNew={dialog.isNew} onClose={() => setDialog(null)} />}
    </>
  );
}


function ConnectionNode({ cfg, onEdit }: { cfg: ConnectionConfig; onEdit: (cfg: ConnectionConfig, isNew: boolean) => void }) {
  const status = useConnections((s) => s.status[cfg.id] ?? "idle");
  const { connect, disconnect, remove, refreshSnapshot } = useConnections.getState();
  const open = useTree((s) => !!s.expanded[cfg.id]);
  const schemas = useTree((s) => s.schemas[cfg.id]);
  const defaultSchema = useConnections((s) => s.defaultSchema[cfg.id]);
  const { toggle, loadSchemas, invalidate } = useTree.getState();
  const openConsole = useTabs((s) => s.openConsole);

  const sql = isSql(cfg.driver);
  const expand = async () => {
    if (open) return toggle(cfg.id, false);
    if (!(await connect(cfg.id))) return;
    toggle(cfg.id, true);
    if (sql) await loadSchemas(cfg.id);
  };
  const refresh = async () => {
    if (cfg.driver === "redis") return refreshRedisTree(cfg.id);
    if (cfg.driver === "mongodb") return refreshMongoTree(cfg.id);
    invalidate(cfg.id);
    await loadSchemas(cfg.id, true);
    await refreshSnapshot(cfg.id);
  };

  // 스키마가 하나뿐(SQLite, MySQL 단일 DB)이거나 기본 스키마가 있으면 자동으로 펼친다
  useEffect(() => {
    if (!Array.isArray(schemas) || !defaultSchema) return;
    const k = nodeKey(cfg.id, defaultSchema);
    if (schemas.includes(defaultSchema) && useTree.getState().expanded[k] === undefined) {
      toggle(k, true);
      void useTree.getState().loadTables(cfg.id, defaultSchema);
    }
  }, [schemas, defaultSchema]);

  const menu = (e: React.MouseEvent) =>
    showContextMenu(e, [
      { label: "새 콘솔", onClick: async () => (await connect(cfg.id)) && openConsole(cfg.id, cfg.name, true) },
      "sep",
      { label: "연결", onClick: () => void expand(), disabled: status === "connected" },
      {
        label: "연결 해제",
        disabled: status !== "connected",
        onClick: async () => {
          if (!(await confirmLeave(cfg.id, "연결을 해제합니다."))) return;
          await disconnect(cfg.id);
          invalidate(cfg.id);
          toggle(cfg.id, false);
        },
      },
      {
        label: "새로고침",
        disabled: status !== "connected",
        onClick: refresh,
      },
      "sep",
      { label: "편집…", onClick: () => onEdit(cfg, false) },
      { label: "복제…", onClick: () => onEdit({ ...cfg, id: crypto.randomUUID(), name: `${cfg.name} 복사본` }, true) },
      {
        label: "삭제",
        onClick: async () => {
          if (await confirmDialog({ title: "접속 삭제", body: `'${cfg.name}' 접속을 삭제할까요?\n저장된 비밀번호와 콘솔도 함께 삭제됩니다.`, okLabel: "삭제", danger: true })) {
            useTabs.getState().closeForConnection(cfg.id);
            invalidate(cfg.id);
            await remove(cfg.id);
          }
        },
      },
    ]);

  return (
    <>
      <Row
        depth={0}
        open={open}
        onToggle={expand}
        onDoubleClick={async () => (await connect(cfg.id)) && openConsole(cfg.id, cfg.name)}
        onContextMenu={menu}
      >
        {cfg.color && <span className="conn-color" style={{ background: cfg.color }} />}
        <span className={`status-dot ${status}`} />
        <DbLogo driver={cfg.driver} />
        <span>{cfg.name}</span>
        {cfg.read_only && <span className="badge">READ ONLY</span>}
      </Row>
      {open && cfg.driver === "redis" && <RedisTree cfg={cfg} />}
      {open && cfg.driver === "mongodb" && <MongoTree cfg={cfg} />}
      {open &&
        sql &&
        (schemas === "loading" ? (
          <Row depth={1} leaf>
            <span className="type">불러오는 중…</span>
          </Row>
        ) : (
          schemas?.map((s) =>
            schemas.length === 1 ? (
              <TablesOf key={s} connId={cfg.id} schema={s} depth={1} />
            ) : (
              <SchemaNode key={s} connId={cfg.id} schema={s} />
            ),
          )
        ))}
    </>
  );
}

function SchemaNode({ connId, schema }: { connId: string; schema: string }) {
  const k = nodeKey(connId, schema);
  const open = useTree((s) => !!s.expanded[k]);
  const { toggle, loadTables } = useTree.getState();
  return (
    <>
      <Row
        depth={1}
        open={open}
        onToggle={() => {
          toggle(k);
          if (!open) void loadTables(connId, schema);
        }}
        onContextMenu={(e) => showContextMenu(e, [{ label: "새로고침", onClick: () => void loadTables(connId, schema, true) }])}
      >
        <span>🗂</span>
        <span>{schema}</span>
      </Row>
      {open && <TablesOf connId={connId} schema={schema} depth={2} />}
    </>
  );
}

function TablesOf({ connId, schema, depth }: { connId: string; schema: string; depth: number }) {
  const k = nodeKey(connId, schema);
  const tables = useTree((s) => s.tables[k]);
  const [filter, setFilter] = useState("");
  useEffect(() => {
    if (!tables) void useTree.getState().loadTables(connId, schema);
  }, [tables]);
  if (!tables || tables === "loading")
    return (
      <Row depth={depth} leaf>
        <span className="type">불러오는 중…</span>
      </Row>
    );
  const f = filter.toLowerCase();
  const shown = f ? tables.filter((t) => t.name.toLowerCase().includes(f)) : tables;
  const plain = shown.filter((t) => t.kind === "TABLE");
  const views = shown.filter((t) => t.kind === "VIEW");
  return (
    <>
      {tables.length > FILTER_THRESHOLD && (
        <div style={{ paddingLeft: 6 + depth * 14 + 16, paddingRight: 6 }}>
          <input style={{ width: "100%" }} placeholder={`${tables.length}개 중 이름 필터`} value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      )}
      <Folder connId={connId} schema={schema} label="tables" items={plain} depth={depth} />
      {views.length > 0 && <Folder connId={connId} schema={schema} label="views" items={views} depth={depth} />}
    </>
  );
}

function Folder(props: { connId: string; schema: string; label: string; items: { name: string; kind: string }[]; depth: number }) {
  const k = nodeKey(props.connId, props.schema, "#" + props.label);
  const open = useTree((s) => s.expanded[k] ?? props.label === "tables");
  return (
    <>
      <Row depth={props.depth} open={open} onToggle={() => useTree.getState().toggle(k, !open)}>
        <span>📁</span>
        <span>{props.label}</span>
        <span className="type">{props.items.length}</span>
      </Row>
      {open && props.items.map((t) => <TableNode key={t.name} connId={props.connId} schema={props.schema} table={t.name} isView={t.kind === "VIEW"} depth={props.depth + 1} />)}
    </>
  );
}

function TableNode(props: { connId: string; schema: string; table: string; isView: boolean; depth: number }) {
  const { connId, schema, table, depth } = props;
  const k = nodeKey(connId, schema, table);
  const open = useTree((s) => !!s.expanded[k]);
  const cols = useTree((s) => s.columns[k]);
  const { toggle, loadColumns, loadIndexes } = useTree.getState();
  const openTable = () => useTabs.getState().openTable(connId, schema, table);
  // 펼친 채로 새로고침하면 캐시만 비워지므로 여기서 다시 불러온다
  useEffect(() => {
    if (open && !cols) void loadColumns(connId, schema, table);
  }, [open, cols]);
  return (
    <>
      <Row
        depth={depth}
        open={open}
        onToggle={() => toggle(k)}
        onDoubleClick={openTable}
        onContextMenu={(e) =>
          showContextMenu(e, [
            { label: "데이터 열기", onClick: openTable },
            {
              label: "새로고침",
              onClick: () => {
                void loadColumns(connId, schema, table, true);
                if (useTree.getState().indexes[k]) void loadIndexes(connId, schema, table, true);
              },
            },
          ])
        }
      >
        <span>{props.isView ? "👁" : "▦"}</span>
        <span>{table}</span>
      </Row>
      {open &&
        (cols === "loading" || !cols ? (
          <Row depth={depth + 1} leaf>
            <span className="type">불러오는 중…</span>
          </Row>
        ) : (
          <>
            <SubFolder k={nodeKey(k, "#columns")} label="columns" count={cols.length} depth={depth + 1} defaultOpen>
              {cols.map((c) => (
                <Row key={c.name} depth={depth + 2} leaf>
                  <span title={c.is_pk ? "기본키" : undefined}>{c.is_pk ? "🔑" : "▫"}</span>
                  <span>{c.name}</span>
                  <span className="type">
                    {c.full_type}
                    {c.nullable ? "" : " not null"}
                  </span>
                </Row>
              ))}
            </SubFolder>
            {!props.isView && <IndexFolder connId={connId} schema={schema} table={table} depth={depth + 1} />}
          </>
        ))}
    </>
  );
}


function IndexFolder(props: { connId: string; schema: string; table: string; depth: number }) {
  const { connId, schema, table, depth } = props;
  const k = nodeKey(connId, schema, table);
  const fk = nodeKey(k, "#indexes");
  const open = useTree((s) => !!s.expanded[fk]);
  const list = useTree((s) => s.indexes[k]);
  useEffect(() => {
    if (open && !list) void useTree.getState().loadIndexes(connId, schema, table);
  }, [open, list]);
  return (
    <SubFolder k={fk} label="indexes" count={Array.isArray(list) ? list.length : undefined} depth={depth}>
      {!Array.isArray(list) ? (
        <Row depth={depth + 1} leaf>
          <span className="type">불러오는 중…</span>
        </Row>
      ) : list.length === 0 ? (
        <Row depth={depth + 1} leaf>
          <span className="type">인덱스 없음</span>
        </Row>
      ) : (
        list.map((ix) => (
          <Row
            key={ix.name}
            depth={depth + 1}
            leaf
            title={`${ix.primary ? "기본키" : ix.unique ? "고유 인덱스" : "인덱스"} ${ix.name}\n컬럼: ${ix.columns.join(", ")}`}
          >
            <span>{ix.primary ? "🔑" : "⚲"}</span>
            <span>{ix.name}</span>
            <span className="type">{ix.primary ? "PK" : ix.unique ? "UNIQUE" : ""}</span>
          </Row>
        ))
      )}
    </SubFolder>
  );
}
