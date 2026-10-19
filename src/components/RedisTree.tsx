import { useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "../api";
import type { ConnectionConfig } from "../api/types";
import { argOf, keyId, showBytes } from "../redis/bytes";
import { buildKeyTree, sortedChildren, type KeyFolder, type ScanKey } from "../redis/keys";
import { SCAN_BATCH, useRedisTree } from "../redis/store";
import { useTabs } from "../store/tabs";
import { nodeKey } from "../store/tree";
import { confirmDialog, promptDialog, toast } from "../store/ui";
import { Hl, Row, SubFolder } from "./TreeRow";
import { showContextMenu } from "./ui";

const TYPE_BADGE: Record<string, string> = { string: "STR", hash: "HASH", list: "LIST", set: "SET", zset: "ZSET", stream: "STRM" };

export function refreshRedisTree(connId: string) {
  const st = useRedisTree.getState();
  const scanned = Object.keys(st.scans)
    .filter((k) => k.startsWith(connId + "|"))
    .map((k) => ({ db: Number(k.split("|")[1]), pattern: st.scans[k].pattern }));
  st.invalidate(connId);
  void st.loadDbs(connId, true);
  for (const s of scanned) void st.scan(connId, s.db, { reset: true, pattern: s.pattern });
}

/** 새 키 만들기: 이름·타입 → 타입별 첫 값. 이미 있으면 만들지 않는다. */
async function newKey(cfg: ConnectionConfig, db: number) {
  const first = await promptDialog({
    title: `새 키 (db${db})`,
    fields: [
      { label: "이름", value: "", placeholder: "예: user:1" },
      {
        label: "타입",
        value: "string",
        options: ["string", "hash", "list", "set", "zset"].map((t) => ({ value: t, label: t })),
      },
    ],
    okLabel: "다음",
  });
  if (!first || !first[0]) return;
  const [name, type] = first;
  const second = await promptDialog({
    title: `새 ${type} 키: ${name}`,
    fields:
      type === "hash"
        ? [{ label: "field", value: "" }, { label: "value", value: "" }]
        : type === "zset"
          ? [{ label: "member", value: "" }, { label: "score", value: "0" }]
          : [{ label: type === "set" ? "member" : "value", value: "" }],
    okLabel: "만들기",
    hint: "Redis에는 빈 컬렉션이 없으므로 첫 원소를 함께 넣습니다.",
  });
  if (!second) return;
  try {
    const exec = (argv: string[]) => api.redisExec(cfg.id, null, db, crypto.randomUUID(), argv);
    const exists = await exec(["EXISTS", name]);
    if (exists.t === "Int" && exists.v > 0) return toast(`이미 '${name}' 키가 있습니다.`, "error");
    const cmd: Record<string, string[]> = {
      string: ["SET", name, second[0], "NX"],
      hash: ["HSET", name, second[0], second[1]],
      list: ["RPUSH", name, second[0]],
      set: ["SADD", name, second[0]],
      zset: ["ZADD", name, second[1] || "0", second[0]],
    };
    const r = await exec(cmd[type]);
    if (r.t === "Error") return toast(r.v, "error");
    useRedisTree.getState().patchKey(cfg.id, db, name, { name: { t: "Text", v: name }, type });
    useTabs.getState().openRedisKey(cfg.id, db, name);
  } catch (e) {
    toast(errorMessage(e), "error");
  }
}

/** Redis 접속 아래: 키가 있는 DB ▸ 구분자 폴더 ▸ 키 */
export function RedisTree({ cfg }: { cfg: ConnectionConfig }) {
  const dbs = useRedisTree((s) => s.dbs[cfg.id]);
  useEffect(() => {
    if (!dbs) void useRedisTree.getState().loadDbs(cfg.id);
  }, [dbs]);
  if (!dbs || dbs === "loading")
    return (
      <Row depth={1} leaf>
        <span className="type">불러오는 중…</span>
      </Row>
    );
  return (
    <>
      {dbs.map((d) => (
        <SubFolder
          key={d.db}
          k={nodeKey(cfg.id, `db${d.db}`)}
          label={`db${d.db}`}
          count={d.keys.toLocaleString()}
          depth={1}
          defaultOpen={d.db === cfg.redis_db}
          onContextMenu={(e) =>
            showContextMenu(e, [
              { label: "새 키…", onClick: () => void newKey(cfg, d.db), disabled: cfg.read_only },
              { label: "새로고침", onClick: () => void useRedisTree.getState().scan(cfg.id, d.db, { reset: true }) },
            ])
          }
        >
          <DbKeys cfg={cfg} db={d.db} />
        </SubFolder>
      ))}
    </>
  );
}

function DbKeys({ cfg, db }: { cfg: ConnectionConfig; db: number }) {
  const scan = useRedisTree((s) => s.scans[`${cfg.id}|${db}`]);
  const [pattern, setPattern] = useState(scan?.pattern ?? "");
  useEffect(() => {
    if (!scan) void useRedisTree.getState().scan(cfg.id, db);
  }, [scan]);
  const tree = useMemo(() => (scan ? buildKeyTree(scan.keys, cfg.key_separator) : null), [scan?.keys, cfg.key_separator]);
  const apply = () => void useRedisTree.getState().scan(cfg.id, db, { reset: true, pattern: pattern.trim() });

  return (
    <>
      <div style={{ paddingLeft: 6 + 2 * 14 + 16, paddingRight: 6 }}>
        <input
          style={{ width: "100%" }}
          placeholder="패턴 (예: user:*) Enter"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && apply()}
        />
      </div>
      {tree && <FolderBody cfg={cfg} db={db} folder={tree} depth={2} />}
      {scan?.loading && (
        <Row depth={2} leaf>
          <span className="type">불러오는 중…</span>
        </Row>
      )}
      {scan && !scan.loading && scan.keys.length === 0 && scan.done && (
        <Row depth={2} leaf>
          <span className="type">{scan.pattern ? "패턴과 맞는 키 없음" : "키 없음"}</span>
        </Row>
      )}
      {scan && !scan.loading && !scan.done && (
        <Row depth={2} nodeId={nodeKey(cfg.id, `db${db}`, "#more")} leaf onToggle={() => void useRedisTree.getState().scan(cfg.id, db)} title="SCAN으로 다음 키를 더 받습니다">
          <span className="link">⋯ 더 불러오기 ({SCAN_BATCH}개)</span>
          <span className="type">{scan.keys.length.toLocaleString()}개 받음</span>
        </Row>
      )}
    </>
  );
}

function FolderBody({ cfg, db, folder, depth }: { cfg: ConnectionConfig; db: number; folder: KeyFolder; depth: number }) {
  const { folders, keys } = sortedChildren(folder);
  return (
    <>
      {folders.map((f) => (
        <SubFolder key={"f:" + f.name} k={nodeKey(cfg.id, `db${db}`, "#k:" + f.path)} label={f.name === "" ? "(빈 이름)" : f.name} count={f.count} depth={depth}>
          <FolderBody cfg={cfg} db={db} folder={f} depth={depth + 1} />
        </SubFolder>
      ))}
      {keys.map((k) => (
        <KeyRow key={"k:" + keyId(k.key.name)} cfg={cfg} db={db} label={k.label} k={k.key} depth={depth} />
      ))}
    </>
  );
}

function KeyRow({ cfg, db, label, k, depth }: { cfg: ConnectionConfig; db: number; label: string; k: ScanKey; depth: number }) {
  const open = () => useTabs.getState().openRedisKey(cfg.id, db, keyId(k.name), k.name.t === "Bin");
  const remove = async () => {
    if (!(await confirmDialog({ title: "키 삭제", body: `db${db}의 키 ${showBytes(k.name)}을(를) 삭제할까요?`, okLabel: "삭제", danger: true }))) return;
    try {
      await api.redisDeleteKey(cfg.id, db, argOf(k.name));
      useRedisTree.getState().patchKey(cfg.id, db, keyId(k.name), null);
      useTabs.getState().renameRedisKey(cfg.id, db, keyId(k.name), null);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  return (
    <Row
      depth={depth}
      nodeId={nodeKey(cfg.id, `db${db}`, "#key:" + keyId(k.name))}
      leaf
      title={showBytes(k.name)}
      onDoubleClick={open}
      onContextMenu={(e) =>
        showContextMenu(e, [
          { label: "열기", onClick: open },
          { label: "삭제…", onClick: () => void remove(), disabled: cfg.read_only },
        ])
      }
    >
      <span className={`key-type t-${k.type}`}>{TYPE_BADGE[k.type] ?? k.type.toUpperCase()}</span>
      <Hl text={label} />
    </Row>
  );
}

