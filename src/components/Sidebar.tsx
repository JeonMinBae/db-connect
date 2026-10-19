import { useEffect, useRef, useState } from "react";
import { isRemote, isSql, type ConnectionConfig, type SqlConfig } from "../api/types";
import { openDropTable } from "./DropTableDialog";
import { MongoTree, refreshMongoTree } from "./MongoTree";
import { RedisTree, refreshRedisTree } from "./RedisTree";
import { useMongoTree } from "../mongo/store";
import { useRedisTree } from "../redis/store";
import { confirmLeave, useConnections } from "../store/connections";
import { searchOpenKeys, useSidebar } from "../store/sidebar";
import { useTabs } from "../store/tabs";
import { nodeKey, useTree } from "../store/tree";
import { confirmDialog } from "../store/ui";
import { DbLogo } from "./dbLogos";
import { Hl, Row, SubFolder } from "./TreeRow";
import { blankConfig, ConnectionDialog } from "./dialogs/ConnectionDialog";
import { showContextMenu, type MenuEntry } from "./ui";

const FILTER_THRESHOLD = 2000;
/** 이만큼(px) 움직여야 드래그로 본다. 그 전에 떼면 평범한 클릭 */
const DRAG_THRESHOLD = 4;
const SEARCH_DEBOUNCE_MS = 150;

/** 검색어가 바뀌거나 새 항목을 불러오면, 이미 불러온 항목 중 일치하는 것이 보이도록 펼친다 */
function useSearchAutoOpen() {
  const query = useSidebar((s) => s.query);
  const configs = useConnections((s) => s.configs);
  const schemas = useTree((s) => s.schemas);
  const tables = useTree((s) => s.tables);
  const redisDbs = useRedisTree((s) => s.dbs);
  const redisScans = useRedisTree((s) => s.scans);
  const mongoDbs = useMongoTree((s) => s.dbs);
  const mongoColls = useMongoTree((s) => s.colls);
  useEffect(() => {
    useTree
      .getState()
      .applySearchOpen(query ? searchOpenKeys(query, { configs, schemas, tables, redisDbs, redisScans, mongoDbs, mongoColls }) : null);
  }, [query, configs, schemas, tables, redisDbs, redisScans, mongoDbs, mongoColls]);
}

function SearchBox() {
  const [text, setText] = useState(useSidebar.getState().query);
  useEffect(() => {
    const t = setTimeout(() => useSidebar.getState().setQuery(text.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text]);
  return (
    <div className="tree-search">
      <input
        placeholder="검색"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setText("");
        }}
      />
    </div>
  );
}

const depthOf = (el: HTMLElement) => Number(el.dataset.depth);

/** 표준 트리 키: ↑↓ 이동, → 펼치기/첫 자식, ← 접기/부모, Home/End, Enter = 더블클릭(없으면 클릭) */
function onTreeKey(e: React.KeyboardEvent<HTMLDivElement>) {
  // 트리 안의 입력칸(Redis 패턴, 테이블 이름 필터)에서 누른 키는 건드리지 않는다
  if (e.target !== e.currentTarget || e.ctrlKey || e.altKey || e.metaKey) return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>(".tree-row[data-node]")];
  if (!rows.length) return;
  const i = rows.findIndex((r) => r.dataset.node === useSidebar.getState().selected);
  const cur = rows[i] as HTMLElement | undefined;
  const go = (el: HTMLElement | undefined) => {
    if (!el) return;
    useSidebar.getState().select(el.dataset.node!);
    el.scrollIntoView({ block: "nearest" });
  };
  switch (e.key) {
    case "ArrowDown":
      go(cur ? rows[i + 1] : rows[0]);
      break;
    case "ArrowUp":
      go(cur ? rows[i - 1] : rows[0]);
      break;
    case "Home":
      go(rows[0]);
      break;
    case "End":
      go(rows[rows.length - 1]);
      break;
    case "ArrowRight":
      if (cur?.dataset.open === "0") cur.click();
      else if (cur?.dataset.open === "1" && rows[i + 1] && depthOf(rows[i + 1]) > depthOf(cur)) go(rows[i + 1]);
      break;
    case "ArrowLeft":
      if (cur?.dataset.open === "1") cur.click();
      else if (cur) go(rows.slice(0, i).reverse().find((r) => depthOf(r) < depthOf(cur)));
      break;
    case "Enter":
      if (cur?.dataset.dbl !== undefined) cur.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      else if (cur?.dataset.act !== undefined) cur.click();
      break;
    default:
      return;
  }
  e.preventDefault();
}

const readOnly = (connId: string) => !!useConnections.getState().configs.find((c) => c.id === connId)?.read_only;

export function Sidebar() {
  const configs = useConnections((s) => s.configs);
  const [dialog, setDialog] = useState<{ cfg: ConnectionConfig; isNew: boolean } | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  /** index: 놓을 자리 (0 = 맨 위, configs.length = 맨 아래) */
  const [drag, setDrag] = useState<{ id: string; index: number } | null>(null);
  useSearchAutoOpen();

  // 접속 줄을 끌어 순서를 바꾼다. Tauri(Windows)는 웹뷰의 HTML5 드래그 이벤트를 가로채므로 포인터 이벤트로 구현한다
  const startDrag = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0 || !(e.target as Element).closest(".conn-head")) return;
    const startY = e.clientY;
    let dropIndex: number | null = null;
    const onMove = (ev: PointerEvent) => {
      if (dropIndex === null && Math.abs(ev.clientY - startY) < DRAG_THRESHOLD) return;
      document.body.classList.add("conn-dragging");
      // 펼쳐진 접속의 하위 트리 위에 있으면 그 접속 바로 뒤로 본다
      const heads = treeRef.current?.querySelectorAll(".conn-head") ?? [];
      dropIndex = [...heads].filter((h) => {
        const r = h.getBoundingClientRect();
        return r.top + r.height / 2 < ev.clientY;
      }).length;
      setDrag({ id, index: dropIndex });
    };
    const end = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      document.body.classList.remove("conn-dragging");
      setDrag(null);
      if (dropIndex === null || ev.type === "pointercancel") return;
      // 놓은 줄에서 이어지는 click 이 접속을 펼치지 않게 한 번 막는다
      const block = (ce: MouseEvent) => ce.stopPropagation();
      window.addEventListener("click", block, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", block, { capture: true }));
      const ids = useConnections.getState().configs.map((c) => c.id);
      const from = ids.indexOf(id);
      const to = dropIndex > from ? dropIndex - 1 : dropIndex;
      if (from < 0 || to === from) return;
      ids.splice(from, 1);
      ids.splice(to, 0, id);
      void useConnections.getState().reorder(ids);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  return (
    <>
      <div className="toolbar">
        <strong>접속</strong>
        <span className="spacer" />
        <button className="icon" title="새 접속" onClick={() => setDialog({ cfg: blankConfig(), isNew: true })}>
          ＋
        </button>
      </div>
      <SearchBox />
      <div className="tree" ref={treeRef} tabIndex={0} onKeyDown={onTreeKey}>
        {configs.length === 0 && <div className="empty" style={{ padding: 20 }}>＋ 버튼으로 접속을 추가하세요</div>}
        {configs.map((c, i) => {
          let cls = "conn-group";
          if (drag?.id === c.id) cls += " dragging";
          if (drag?.index === i) cls += " drop-before";
          if (drag?.index === configs.length && i === configs.length - 1) cls += " drop-after";
          return (
            <div key={c.id} className={cls} onPointerDown={(e) => startDrag(e, c.id)}>
              <ConnectionNode cfg={c} onEdit={(cfg, isNew) => setDialog({ cfg, isNew })} />
            </div>
          );
        })}
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
  const openBrowser = useTabs((s) => s.openBrowser);

  const remote = isRemote(cfg.driver);
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

  const commonItems: MenuEntry[] = [
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
  ];

  const remoteMenu: MenuEntry[] = [
    { label: "새 브라우저 탭", onClick: async () => (await connect(cfg.id)) && openBrowser(cfg.id, cfg.name, true) },
    "sep",
    { label: "연결", onClick: () => void connect(cfg.id), disabled: status === "connected" },
    {
      label: "연결 해제",
      disabled: status !== "connected",
      onClick: async () => {
        if (!(await confirmLeave(cfg.id, "연결을 해제합니다."))) return;
        await disconnect(cfg.id);
      },
    },
    "sep",
    ...commonItems,
  ];

  const menu = (e: React.MouseEvent) =>
    showContextMenu(e, remote ? remoteMenu : [
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
      ...commonItems,
    ]);

  return (
    <>
      <Row
        depth={0}
        className="conn-head"
        nodeId={cfg.id}
        open={open}
        leaf={remote}
        onToggle={expand}
        onDoubleClick={async () => (await connect(cfg.id)) && (remote ? openBrowser(cfg.id, cfg.name) : openConsole(cfg.id, cfg.name))}
        onContextMenu={menu}
      >
        {cfg.color && <span className="conn-color" style={{ background: cfg.color }} />}
        <span className={`status-dot ${status}`} />
        <DbLogo driver={cfg.driver} />
        <Hl text={cfg.name} />
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
        nodeId={k}
        open={open}
        onToggle={() => {
          toggle(k);
          if (!open) void loadTables(connId, schema);
        }}
        onContextMenu={(e) =>
          showContextMenu(e, [
            { label: "새 테이블…", disabled: readOnly(connId), onClick: () => useTabs.getState().openNewTable(connId, schema) },
            { label: "새로고침", onClick: () => void loadTables(connId, schema, true) },
          ])
        }
      >
        <span>🗂</span>
        <Hl text={schema} />
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
      <Row
        depth={props.depth}
        nodeId={k}
        open={open}
        onToggle={() => useTree.getState().toggle(k, !open)}
        onContextMenu={
          props.label === "tables"
            ? (e) => showContextMenu(e, [{ label: "새 테이블…", disabled: readOnly(props.connId), onClick: () => useTabs.getState().openNewTable(props.connId, props.schema) }])
            : undefined
        }
      >
        <span>📁</span>
        <Hl text={props.label} />
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
        nodeId={k}
        open={open}
        onToggle={() => toggle(k)}
        onDoubleClick={openTable}
        onContextMenu={(e) =>
          showContextMenu(e, [
            { label: "데이터 열기", onClick: openTable },
            { label: "구조 편집", disabled: props.isView, onClick: () => useTabs.getState().openStructure(connId, schema, table) },
            {
              label: "테이블 삭제…",
              disabled: props.isView || readOnly(connId),
              onClick: () => {
                const cfg = useConnections.getState().configs.find((c) => c.id === connId);
                if (cfg && isSql(cfg.driver)) void openDropTable(cfg as SqlConfig, schema, table);
              },
            },
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
        <Hl text={table} />
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
                <Row key={c.name} depth={depth + 2} nodeId={nodeKey(k, "#columns", c.name)} leaf>
                  <span title={c.is_pk ? "기본키" : undefined}>{c.is_pk ? "🔑" : "▫"}</span>
                  <Hl text={c.name} />
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
            nodeId={nodeKey(fk, ix.name)}
            leaf
            title={`${ix.primary ? "기본키" : ix.unique ? "고유 인덱스" : "인덱스"} ${ix.name}\n컬럼: ${ix.columns.join(", ")}`}
          >
            <span>{ix.primary ? "🔑" : "⚲"}</span>
            <Hl text={ix.name} />
            <span className="type">{ix.primary ? "PK" : ix.unique ? "UNIQUE" : ""}</span>
          </Row>
        ))
      )}
    </SubFolder>
  );
}
