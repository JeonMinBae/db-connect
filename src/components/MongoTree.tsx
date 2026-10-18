import { useEffect } from "react";
import type { ConnectionConfig } from "../api/types";
import { formatShell } from "../mongo/shell";
import { useMongoTree, type MongoColl } from "../mongo/store";
import { useConnections } from "../store/connections";
import { useTabs } from "../store/tabs";
import { nodeKey, useTree } from "../store/tree";
import { sizeText } from "../redis/view";
import { Row, SubFolder } from "./TreeRow";
import { showContextMenu } from "./ui";

export function refreshMongoTree(connId: string) {
  const st = useMongoTree.getState();
  st.invalidate(connId);
  void st.loadDbs(connId, true);
}

const loadingRow = (depth: number) => (
  <Row depth={depth} leaf>
    <span className="type">불러오는 중…</span>
  </Row>
);

/** MongoDB 접속 아래: DB ▸ collections / views ▸ 컬렉션 ▸ indexes */
export function MongoTree({ cfg }: { cfg: ConnectionConfig }) {
  const dbs = useMongoTree((s) => s.dbs[cfg.id]);
  const defaultDb = useConnections((s) => s.defaultSchema[cfg.id]);
  useEffect(() => {
    if (!dbs) void useMongoTree.getState().loadDbs(cfg.id);
  }, [dbs]);
  if (!dbs || dbs === "loading") return loadingRow(1);
  return (
    <>
      {dbs.map((d) => (
        <SubFolder
          key={d.name}
          k={nodeKey(cfg.id, d.name)}
          label={d.name}
          count={d.size ? sizeText(d.size) : undefined}
          depth={1}
          defaultOpen={d.name === defaultDb}
          onContextMenu={(e) => showContextMenu(e, [{ label: "새로고침", onClick: () => void useMongoTree.getState().loadColls(cfg.id, d.name, true) }])}
        >
          <DbBody cfg={cfg} db={d.name} />
        </SubFolder>
      ))}
    </>
  );
}

function DbBody({ cfg, db }: { cfg: ConnectionConfig; db: string }) {
  const colls = useMongoTree((s) => s.colls[`${cfg.id}|${db}`]);
  useEffect(() => {
    if (!colls) void useMongoTree.getState().loadColls(cfg.id, db);
  }, [colls]);
  if (!colls || colls === "loading") return loadingRow(2);
  const plain = colls.filter((c) => c.kind !== "view");
  const views = colls.filter((c) => c.kind === "view");
  return (
    <>
      <SubFolder k={nodeKey(cfg.id, db, "#collections")} label="collections" count={plain.length} depth={2} defaultOpen>
        {plain.map((c) => (
          <CollNode key={c.name} cfg={cfg} db={db} coll={c} depth={3} />
        ))}
      </SubFolder>
      {views.length > 0 && (
        <SubFolder k={nodeKey(cfg.id, db, "#views")} label="views" count={views.length} depth={2}>
          {views.map((c) => (
            <CollNode key={c.name} cfg={cfg} db={db} coll={c} depth={3} />
          ))}
        </SubFolder>
      )}
    </>
  );
}

function CollNode({ cfg, db, coll, depth }: { cfg: ConnectionConfig; db: string; coll: MongoColl; depth: number }) {
  const k = nodeKey(cfg.id, db, coll.name);
  const open = useTree((s) => !!s.expanded[k]);
  const openTab = () => useTabs.getState().openMongoColl(cfg.id, db, coll.name);
  const isView = coll.kind === "view";
  return (
    <>
      <Row
        depth={depth}
        open={open}
        leaf={isView}
        onToggle={() => !isView && useTree.getState().toggle(k)}
        onDoubleClick={openTab}
        onContextMenu={(e) =>
          showContextMenu(e, [
            { label: "열기", onClick: openTab },
            { label: "인덱스 새로고침", onClick: () => void useMongoTree.getState().loadIndexes(cfg.id, db, coll.name, true), disabled: isView },
          ])
        }
      >
        <span>{isView ? "👁" : "▤"}</span>
        <span>{coll.name}</span>
        {coll.estimated != null && <span className="type">{coll.estimated.toLocaleString()}</span>}
      </Row>
      {open && !isView && <IndexFolder cfg={cfg} db={db} coll={coll.name} depth={depth + 1} />}
    </>
  );
}

function IndexFolder({ cfg, db, coll, depth }: { cfg: ConnectionConfig; db: string; coll: string; depth: number }) {
  const fk = nodeKey(cfg.id, db, coll, "#indexes");
  const open = useTree((s) => s.expanded[fk] ?? true);
  const list = useMongoTree((s) => s.indexes[`${cfg.id}|${db}|${coll}`]);
  useEffect(() => {
    if (open && !list) void useMongoTree.getState().loadIndexes(cfg.id, db, coll);
  }, [open, list]);
  return (
    <SubFolder k={fk} label="indexes" count={Array.isArray(list) ? list.length : undefined} depth={depth} defaultOpen>
      {!Array.isArray(list)
        ? loadingRow(depth + 1)
        : list.map((ix) => {
            const keys = formatShell(ix.keys);
            const opts = [ix.unique && "unique", ix.ttl != null && `TTL ${ix.ttl}초`, ix.partial && "partial"].filter(Boolean).join(", ");
            return (
              <Row key={ix.name} depth={depth + 1} leaf title={`인덱스 ${ix.name}\n키: ${keys}${opts ? `\n옵션: ${opts}` : ""}`}>
                <span>{ix.name === "_id_" ? "🔑" : "⚲"}</span>
                <span>{ix.name}</span>
                <span className="type">{ix.unique ? "UNIQUE" : ix.ttl != null ? "TTL" : ""}</span>
              </Row>
            );
          })}
    </SubFolder>
  );
}
