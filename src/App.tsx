import { useEffect, useState } from "react";
import { ConsoleTab } from "./components/ConsoleTab";
import { MongoCollTab } from "./components/MongoCollTab";
import { MongoConsoleTab } from "./components/MongoConsoleTab";
import { RedisConsoleTab } from "./components/RedisConsoleTab";
import { RedisKeyTab } from "./components/RedisKeyTab";
import { Sidebar } from "./components/Sidebar";
import { TableViewTab } from "./components/TableViewTab";
import { StructureTab } from "./components/StructureTab";
import { DropTableHost } from "./components/DropTableDialog";
import { ExportProgressHost } from "./components/exportMenu";
import { ConfirmHost, ContextMenuHost, PromptHost, Splitter, Toasts, showContextMenu } from "./components/ui";
import { useConnections } from "./store/connections";
import { isRemote, isSql, type ConnectionConfig, type SqlConfig } from "./api/types";
import { useTabs, type Tab } from "./store/tabs";
import { useColorScheme, type Scheme } from "./theme";

const TAB_ICON: Record<Tab["kind"], string> = { console: "⌨", table: "▦", structure: "⚙", redisKey: "🔑", mongoColl: "▤", remoteBrowser: "🗁", remoteFile: "📝" };

const tabDetail = (t: Tab) =>
  t.kind === "table" || t.kind === "structure" ? ` · ${t.schema}.${t.table}` : t.kind === "redisKey" ? ` · db${t.db} · ${t.key}` : t.kind === "mongoColl" ? ` · ${t.db}.${t.coll}` : t.kind === "remoteFile" ? ` · ${t.path}` : "";

/** 탭 종류와 접속 드라이버에 맞는 화면 */
function TabBody({ tab: t, cfg, scheme, active }: { tab: Tab; cfg: ConnectionConfig; scheme: Scheme; active: boolean }) {
  if (isSql(cfg.driver)) {
    const sql = cfg as SqlConfig;
    if (t.kind === "console") return <ConsoleTab tabId={t.id} cfg={sql} scheme={scheme} active={active} />;
    if (t.kind === "table") return <TableViewTab tabId={t.id} cfg={sql} schema={t.schema} table={t.table} scheme={scheme} active={active} />;
    if (t.kind === "structure") return <StructureTab tabId={t.id} cfg={sql} schema={t.schema} table={t.table} isNew={t.isNew} scheme={scheme} active={active} />;
  }
  if (cfg.driver === "redis") {
    if (t.kind === "console") return <RedisConsoleTab tabId={t.id} cfg={cfg} scheme={scheme} active={active} />;
    if (t.kind === "redisKey") return <RedisKeyTab tabId={t.id} cfg={cfg} db={t.db} keyName={t.key} binary={t.binary} scheme={scheme} active={active} />;
  }
  if (cfg.driver === "mongodb") {
    if (t.kind === "console") return <MongoConsoleTab tabId={t.id} cfg={cfg} scheme={scheme} active={active} />;
    if (t.kind === "mongoColl") return <MongoCollTab tabId={t.id} cfg={cfg} db={t.db} coll={t.coll} scheme={scheme} active={active} />;
  }
  // 브라우저·편집 탭 컴포넌트는 이후 작업에서 연결한다
  if (isRemote(cfg.driver)) return <div className="empty">준비 중</div>;
  return <div className="empty">이 접속에서는 열 수 없는 탭입니다</div>;
}

export default function App() {
  const scheme = useColorScheme();
  const [sidebarWidth, setSidebarWidth] = useState(260);
  // 필요한 값만 구독한다 (dirty가 바뀔 때마다 모든 탭이 다시 그려지지 않도록)
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const restored = useTabs((s) => s.restored);
  const dirty = useTabs((s) => s.dirty);
  const configs = useConnections((s) => s.configs);

  useEffect(() => {
    void useConnections.getState().load().then(() => useTabs.getState().restore());
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === "w") {
        e.preventDefault();
        const id = useTabs.getState().activeId;
        if (id) void useTabs.getState().close(id);
      } else if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        useTabs.getState().next(e.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey, true);
    // 기본 브라우저 컨텍스트 메뉴 막기 (입력란 제외)
    const noMenu = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (!el.closest("input, textarea, .cm-editor")) e.preventDefault();
    };
    window.addEventListener("contextmenu", noMenu);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("contextmenu", noMenu);
    };
  }, []);

  const cfgOf = (id: string) => configs.find((c) => c.id === id);

  return (
    <div className="app">
      <div className="sidebar" style={{ width: sidebarWidth }}>
        <Sidebar />
      </div>
      <Splitter dir="v" size={sidebarWidth} onResize={setSidebarWidth} min={160} max={700} />
      <div className="main">
        <div className="tabbar">
          {tabs.map((t) => {
            const cfg = cfgOf(t.connId);
            return (
              <div
                key={t.id}
                className={`tab${t.id === activeId ? " active" : ""}`}
                style={cfg?.color ? ({ "--tab-color": cfg.color } as React.CSSProperties) : undefined}
                onMouseDown={(e) => {
                  if (e.button === 1) void useTabs.getState().close(t.id);
                  else if (e.button === 0) useTabs.getState().activate(t.id);
                }}
                onContextMenu={(e) =>
                  showContextMenu(e, [
                    { label: "닫기", onClick: () => void useTabs.getState().close(t.id) },
                    { label: "다른 탭 모두 닫기", onClick: () => void useTabs.getState().closeMany(tabs.filter((o) => o.id !== t.id).map((o) => o.id)) },
                  ])
                }
                title={cfg ? `${cfg.name}${tabDetail(t)}` : undefined}
              >
                <span>{TAB_ICON[t.kind]}</span>
                <span>
                  {dirty[t.id] ? "* " : ""}
                  {t.title}
                </span>
                {cfg?.read_only && <span className="badge" style={{ fontSize: 9, padding: "0 3px" }}>RO</span>}
                <span
                  className="close"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => void useTabs.getState().close(t.id)}
                >
                  ✕
                </span>
              </div>
            );
          })}
        </div>
        {restored && tabs.length === 0 && <div className="empty">왼쪽에서 접속을 더블클릭하면 콘솔이 열립니다</div>}
        {tabs.map((t) => {
          const cfg = cfgOf(t.connId);
          if (!cfg) return null;
          const active = t.id === activeId;
          return (
            <div key={t.id} className="tab-body" hidden={!active}>
              <TabBody tab={t} cfg={cfg} scheme={scheme} active={active} />
            </div>
          );
        })}
      </div>
      <ContextMenuHost />
      <ConfirmHost />
      <PromptHost />
      <DropTableHost />
      <ExportProgressHost />
      <Toasts />
    </div>
  );
}
