import type { ReactNode } from "react";
import { fmtElapsed, fmtStat, type SelStats } from "../grid/selStats";

/** 상태 표시줄 왼쪽: 페치 시간 │ 선택 집계 │ 기타. 빈 칸은 구분선도 그리지 않는다 */
export function StatusCells({ ms, msTitle, stats, children }: { ms: number; msTitle: string; stats: SelStats | null; children?: ReactNode }) {
  return (
    <span className="status-cells">
      <span title={msTitle}>↓ {fmtElapsed(ms)}</span>
      {stats && stats.count >= 2 && (
        <span>
          {stats.count.toLocaleString()}칸
          {stats.sum !== null && ` · 합계 ${fmtStat(stats.sum)} · 평균 ${fmtStat(stats.avg!)}`}
        </span>
      )}
      {children}
    </span>
  );
}
