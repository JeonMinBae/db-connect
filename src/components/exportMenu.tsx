import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { api, errorMessage } from "../api";
import type { ColumnInfo, SqlConfig } from "../api/types";
import { slice, toInsert, toJson, toTsv } from "../grid/serialize";
import type { ResultEntry } from "../grid/useRunner";
import { qualified } from "../sql/quote";
import { toast } from "../store/ui";
import type { GridApi } from "./ResultGrid";
import { Modal, type MenuEntry } from "./ui";

interface ExportJob {
  execId: string;
}
const useExport = create<{ job: ExportJob | null }>(() => ({ job: null }));

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what}(으)로 복사했습니다.`);
  } catch (e) {
    toast(`복사 실패: ${errorMessage(e)}`, "error");
  }
}

/** 진행 표시와 함께 파일 내보내기를 실행한다. 저장 위치는 백엔드가 대화상자로 고른다 (웹뷰가 임의 경로에 쓰지 못하게) */
export async function runExport(fileName: string, run: (execId: string, fileName: string) => Promise<{ path: string; rows: number } | null>, unit = "행을") {
  const execId = crypto.randomUUID();
  useExport.setState({ job: { execId } });
  try {
    const res = await run(execId, fileName);
    if (res) toast(`${res.rows.toLocaleString()}${unit} 내보냈습니다.\n${res.path}`);
  } catch (e) {
    toast(`내보내기 실패: ${errorMessage(e)}`, "error");
  } finally {
    useExport.setState({ job: null });
  }
}

const exportCsv = (cfg: SqlConfig, consoleId: string | null, sql: string, name: string) =>
  runExport(`${name}.csv`, (execId, file_name) => api.exportCsv({ conn_id: cfg.id, console_id: consoleId, exec_id: execId, sql, file_name, bom: true }));

type TableRef = { schema: string | null; table: string } | null;

/** 복사 항목. 선택이 없으면 현재 페이지 전체 */
export function copyMenuItems(grid: GridApi, columns: ColumnInfo[], cfg: SqlConfig, table: TableRef): MenuEntry[] {
  const sel = () => slice(columns, grid.getRow, grid.rowCount, grid.range, grid.rows);
  const tableName = table ? qualified(cfg.driver, table.schema, table.table) : "<table>";
  const scope = grid.range && grid.range.width * grid.range.height > 1 ? "선택 영역" : grid.rows.length ? "선택 행" : "현재 페이지";
  return [
    { label: `TSV (${scope}, 헤더 포함)`, onClick: () => copy(toTsv(sel(), true), "TSV") },
    { label: `JSON (${scope})`, onClick: () => copy(toJson(sel()), "JSON") },
    { label: `SQL INSERT (${scope})`, onClick: () => copy(toInsert(sel(), cfg.driver, tableName), "INSERT 문") },
  ];
}

/** CSV 내보내기는 쿼리를 다시 실행하므로, 데이터를 바꾸는 문장(DML ... RETURNING, 변경 CTE)은 막는다 */
export const canExportCsv = (entry: ResultEntry) => entry.stmt.rerunSafe;

export function exportCsvOf(entry: ResultEntry, cfg: SqlConfig, consoleId: string | null, table: TableRef) {
  if (canExportCsv(entry)) void exportCsv(cfg, consoleId, entry.stmt.text, table?.table ?? "result");
}

/** 결과 그리드 우클릭 메뉴의 복사·내보내기 항목 (툴바 버튼과 같은 동작) */
export function exportMenuItems(
  grid: GridApi,
  entry: ResultEntry,
  columns: ColumnInfo[],
  cfg: SqlConfig,
  consoleId: string | null,
  table: TableRef,
): MenuEntry[] {
  return [
    ...copyMenuItems(grid, columns, cfg, table).map((m) => (m === "sep" ? m : { ...m, label: `복사: ${m.label}` })),
    "sep",
    {
      label: canExportCsv(entry) ? "CSV로 내보내기… (쿼리 전체 결과)" : "CSV로 내보내기… (다시 실행하면 데이터가 바뀌는 문장이라 불가)",
      onClick: () => exportCsvOf(entry, cfg, consoleId, table),
      disabled: !canExportCsv(entry),
    },
  ];
}

/** 내보내기 진행 표시 (앱 전체에 하나) */
export function ExportProgressHost() {
  const job = useExport((s) => s.job);
  const [rows, setRows] = useState(0);
  useEffect(() => {
    const un = listen<{ exec_id: string; rows: number }>("export-progress", (e) => {
      if (e.payload.exec_id === useExport.getState().job?.execId) setRows(e.payload.rows);
    });
    return () => void un.then((f) => f());
  }, []);
  useEffect(() => setRows(0), [job?.execId]);
  if (!job) return null;
  return (
    <Modal
      title="파일로 내보내는 중"
      onClose={() => {}}
      footer={
        <button className="danger" onClick={() => void api.cancelQuery(job.execId)}>
          취소
        </button>
      }
    >
      {`${rows.toLocaleString()}행 기록함`}
    </Modal>
  );
}
