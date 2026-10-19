import { memo, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../../api";
import type { ConnectionConfig, OpenText, RemoteStamp, TextMeta } from "../../api/types";
import { loadLanguage } from "../../remote/language";
import { useTabs } from "../../store/tabs";
import { confirmDialog, toast } from "../../store/ui";
import type { Scheme } from "../../theme";
import { SqlEditor, type SqlEditorHandle } from "../SqlEditor";
import type { Extension } from "@codemirror/state";

type Loaded =
  | { t: "Text"; text: string; meta: TextMeta; language: Extension }
  | { t: "Binary" }
  | { t: "TooLarge"; size: number };

const DIRTY_REASON = "저장하지 않은 변경이 있습니다";
const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

export const RemoteFileTab = memo(function RemoteFileTab(props: { tabId: string; cfg: ConnectionConfig; path: string; scheme: Scheme; active: boolean }) {
  const { tabId, cfg, path } = props;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirtyState] = useState(false);
  const [saving, setSaving] = useState(false);
  // 다시 불러오면 에디터를 새로 만들어야 하므로 key 로 쓴다
  const [gen, setGen] = useState(0);
  const editor = useRef<SqlEditorHandle>(null);
  const started = useRef(false);
  const stamp = useRef<RemoteStamp | null>(null);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  // 저장하는 동안 입력이 더 들어왔는지 구분하려고 변경 때마다 올린다
  const version = useRef(0);
  const metaRef = useRef<TextMeta | null>(null);

  const setDirty = (d: boolean) => {
    dirtyRef.current = d;
    setDirtyState(d);
    useTabs.getState().setDirty(tabId, "edit", d ? DIRTY_REASON : null);
  };

  const load = async () => {
    setError(null);
    setLoaded(null);
    try {
      const r: OpenText = await api.remoteOpenText(cfg.id, path);
      if (r.t === "Text") {
        const language = await loadLanguage(baseName(path)).catch(() => [] as Extension);
        stamp.current = r.stamp;
        metaRef.current = r.meta;
        version.current++;
        setDirty(false);
        setGen((g) => g + 1);
        setLoaded({ t: "Text", text: r.text, meta: r.meta, language });
      } else setLoaded(r);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  // 처음 보일 때 한 번만 읽는다
  useEffect(() => {
    if (props.active && !started.current) {
      started.current = true;
      void load();
    }
  }, [props.active]);

  // 탭이 닫히면 미저장 표시를 남기지 않는다
  useEffect(() => () => useTabs.getState().setDirty(tabId, "edit", null), []);

  const save = async () => {
    if (savingRef.current || !stamp.current || !metaRef.current) return;
    if (cfg.read_only) return void toast("읽기 전용 접속입니다", "error");
    if (!dirtyRef.current) return;
    savingRef.current = true;
    setSaving(true);
    const text = editor.current?.getText() ?? "";
    const sent = version.current;
    try {
      let r = await api.remoteSaveText(cfg.id, path, metaRef.current, text, stamp.current, false);
      if (r.t === "Conflict") {
        const ok = await confirmDialog({ title: "저장", body: "다른 곳에서 파일이 바뀌었습니다. 덮어쓸까요?", okLabel: "덮어쓰기", danger: true });
        if (!ok) return;
        r = await api.remoteSaveText(cfg.id, path, metaRef.current, text, stamp.current, true);
      }
      if (r.t === "Saved") {
        stamp.current = r.stamp;
        if (version.current === sent) setDirty(false);
        toast("저장했습니다");
      }
    } catch (e) {
      // 인코딩 변환 실패 등: 수정 상태를 유지한다
      toast(errorMessage(e), "error");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  const reload = async () => {
    if (dirtyRef.current && !(await confirmDialog({ title: "다시 불러오기", body: "저장하지 않은 변경이 사라집니다. 다시 불러올까요?", okLabel: "다시 불러오기", danger: true }))) return;
    void load();
  };

  // 편집기로 열 수 없는 파일은 단일 파일 저장 대화상자로 바로 내려받는다
  const download = async () => {
    let pickId: string | null = null;
    try {
      const pick = await api.pickDownloadTarget(baseName(path));
      if (!pick) return;
      pickId = pick.pick_id;
      await api.transferStart(cfg.id, crypto.randomUUID(), { kind: "download", paths: [path], pick_id: pick.pick_id });
      toast("다운로드했습니다");
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      if (pickId) void api.pickRelease(pickId).catch(() => {});
    }
  };

  const editable = loaded?.t === "Text";
  const meta = loaded?.t === "Text" ? loaded.meta : null;

  return (
    <>
      <div className="toolbar">
        <button onClick={() => void save()} disabled={!editable || !dirty || saving || cfg.read_only} title="저장 (Ctrl+S)">
          저장
        </button>
        <button onClick={() => void reload()} disabled={saving}>
          다시 불러오기
        </button>
        <span className="spacer" />
        <span className="label">{path}</span>
      </div>
      {loaded === null && !error && <div className="empty">불러오는 중…</div>}
      {error && <div className="empty">{error}</div>}
      {loaded?.t === "Binary" && (
        <div className="empty remote-file-fallback">
          <span>텍스트 파일이 아닙니다</span>
          <button onClick={() => void download()}>다운로드</button>
        </div>
      )}
      {loaded?.t === "TooLarge" && (
        <div className="empty remote-file-fallback">
          <span>5MB 를 넘어 편집할 수 없습니다</span>
          <button onClick={() => void download()}>다운로드</button>
        </div>
      )}
      {loaded?.t === "Text" && (
        <div style={{ flex: 1, minHeight: 0 }}>
          <SqlEditor
            key={gen}
            ref={editor}
            language={loaded.language}
            scheme={props.scheme}
            initialText={loaded.text}
            onChange={() => {
              version.current++;
              if (!dirtyRef.current) setDirty(true);
            }}
            extraKeys={[
              {
                key: "Mod-s",
                run: () => {
                  void saveRef.current();
                  return true;
                },
              },
            ]}
          />
        </div>
      )}
      {meta && (
        <div className="statusbar">
          <span>{meta.encoding === "utf8" ? "UTF-8" : "EUC-KR"}</span>
          {meta.bom && <span>BOM</span>}
          <span>{meta.crlf ? "CRLF" : "LF"}</span>
          <span className="spacer" />
          {cfg.read_only && <span className="badge">READ ONLY</span>}
          <span>{saving ? "저장 중…" : dirty ? "수정됨" : "저장됨"}</span>
        </div>
      )}
    </>
  );
});
