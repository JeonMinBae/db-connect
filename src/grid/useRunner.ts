import { useRef, useState } from "react";
import { api, errorMessage } from "../api";
import type { ExecResult } from "../api/types";
import type { EditTarget } from "../sql/editable";
import { usePrefs } from "../store/prefs";
import { toast } from "../store/ui";

export interface RunStmt {
  text: string;
  /** 그리드 편집 대상 테이블 (없으면 읽기 전용) */
  target?: EditTarget;
  isQuery: boolean;
  pageable: boolean;
  /** 다시 실행해도 데이터가 바뀌지 않는 조회문인지 (CSV 내보내기용) */
  rerunSafe: boolean;
  from?: number;
  to?: number;
}

export interface ResultEntry {
  key: string;
  title: string;
  stmt: RunStmt;
  status: "running" | "done" | "error" | "cancelled";
  execId: string;
  startedAt: number;
  offset: number;
  /** 마지막 실행에 쓴 페이지 크기 */
  pageSize: number;
  result?: ExecResult;
  error?: string;
  total?: number | null;
  counting?: boolean;
}

/** runAll 결과: ok = 모든 문장이 성공, ran = 성공한 문장 수 */
export interface RunOutcome {
  ok: boolean;
  ran: number;
}

const uid = () => crypto.randomUUID();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 콘솔/테이블 뷰 공용 쿼리 실행 상태 */
export function useRunner(connId: string, consoleId: string | null) {
  const [entries, setEntries] = useState<ResultEntry[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [running, setRunning] = useState<ResultEntry | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  // 렌더 주기와 무관하게 재진입을 막는다 (Ctrl+Enter 연타)
  const busy = useRef(false);
  const runningRef = useRef<ResultEntry | null>(null);
  const cancelled = useRef(new Set<string>());
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  const patch = (key: string, p: Partial<ResultEntry>) => setEntries((es) => es.map((e) => (e.key === key ? { ...e, ...p } : e)));

  const exec = async (entry: ResultEntry, offset: number): Promise<string | null> => {
    const execId = uid();
    const pageSize = usePrefs.getState().pageSize;
    const started = { ...entry, status: "running" as const, execId, startedAt: Date.now(), offset, pageSize };
    runningRef.current = started;
    setRunning(started);
    patch(entry.key, { status: "running", execId, startedAt: started.startedAt, offset, pageSize });
    try {
      const result = await api.execute({
        conn_id: connId,
        console_id: consoleId,
        exec_id: execId,
        sql: entry.stmt.text,
        is_query: entry.stmt.isQuery,
        paged: entry.stmt.pageable,
        offset,
        page_size: pageSize,
      });
      // MySQL SLEEP 등은 중지돼도 정상 결과를 돌려주므로, 중지를 눌렀다면 결과와 관계없이 중지로 표시한다
      if (cancelled.current.delete(execId)) {
        patch(entry.key, { status: "cancelled", error: "사용자가 쿼리를 중지했습니다." });
        return "cancelled";
      }
      patch(entry.key, { status: "done", result, error: undefined });
      return null;
    } catch (e) {
      const wasCancelled = cancelled.current.delete(execId);
      const msg = wasCancelled ? "사용자가 쿼리를 중지했습니다." : errorMessage(e);
      patch(entry.key, { status: wasCancelled ? "cancelled" : "error", error: msg });
      return msg;
    } finally {
      runningRef.current = null;
      setRunning(null);
    }
  };

  /** 문장들을 순서대로 실행한다. 오류나 취소가 나면 멈춘다. 결과 탭은 새로 만든다. */
  const runAll = async (stmts: RunStmt[], onStart?: (s: RunStmt) => void, opts?: { keepOnError?: boolean }): Promise<RunOutcome> => {
    if (busy.current || !stmts.length) return { ok: false, ran: 0 };
    busy.current = true;
    try {
      const prev = entriesRef.current;
      const prevActive = activeKey;
      const fresh: ResultEntry[] = stmts.map((s, i) => ({
        key: uid(),
        title: stmts.length > 1 ? `결과 ${i + 1}` : "결과",
        stmt: s,
        status: "running",
        execId: "",
        startedAt: Date.now(),
        offset: 0,
        pageSize: usePrefs.getState().pageSize,
      }));
      setEntries(fresh);
      for (const [i, entry] of fresh.entries()) {
        setActiveKey(entry.key);
        onStart?.(entry.stmt);
        const err = await exec(entry, 0);
        if (err !== null) {
          if (opts?.keepOnError && prev.some((e) => e.status === "done")) {
            // 이전 결과를 유지하고 오류만 보여 준다
            setEntries(prev);
            setActiveKey(prevActive);
            setLastError(err);
          } else {
            // 실행하지 못한 나머지 탭은 지운다
            setEntries((es) => es.slice(0, i + 1));
          }
          return { ok: false, ran: i };
        }
      }
      setLastError(null);
      return { ok: true, ran: fresh.length };
    } finally {
      busy.current = false;
    }
  };

  const page = async (key: string, offset: number) => {
    const entry = entriesRef.current.find((e) => e.key === key);
    if (!entry || busy.current) return;
    busy.current = true;
    try {
      await exec(entry, Math.max(0, offset));
    } finally {
      busy.current = false;
    }
  };

  const count = async (key: string) => {
    const entry = entriesRef.current.find((e) => e.key === key);
    if (!entry) return;
    patch(key, { counting: true });
    try {
      patch(key, { total: await api.countRows(connId, consoleId, entry.stmt.text), counting: false });
    } catch (e) {
      patch(key, { counting: false });
      toast(`행 수를 조회하지 못했습니다: ${errorMessage(e)}`, "error");
    }
  };

  /** 중지. 실행 직후라 취소 핸들이 아직 등록되지 않았으면 잠시 뒤 다시 시도한다. */
  const cancel = async () => {
    const r = runningRef.current;
    if (!r) return;
    cancelled.current.add(r.execId);
    try {
      for (let i = 0; i < 10; i++) {
        if (await api.cancelQuery(r.execId)) return;
        if (runningRef.current?.execId !== r.execId) return;
        await sleep(100);
      }
    } catch (e) {
      cancelled.current.delete(r.execId);
      throw e;
    }
  };

  /** 결과를 그대로 두고 현재 페이지를 다시 읽는다 */
  const refresh = (key: string) => page(key, entriesRef.current.find((e) => e.key === key)?.offset ?? 0);

  return { entries, activeKey, setActiveKey, running, lastError, runAll, page, count, cancel, refresh };
}
