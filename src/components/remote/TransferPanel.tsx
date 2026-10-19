import { useState } from "react";
import { sizeText } from "../../remote/browser";
import { useTransfers, type TransferItem } from "../../remote/transfers";
import { Modal, Splitter } from "../ui";

const STATUS: Record<TransferItem["status"], string> = { queued: "대기", running: "전송 중", done: "완료", failed: "실패", canceled: "취소됨" };

function Row({ it }: { it: TransferItem }) {
  const { cancel, retry } = useTransfers.getState();
  const indeterminate = it.status === "running" && it.totalBytes === 0;
  const pct = it.status === "done" ? 100 : it.totalBytes > 0 ? Math.min(100, (it.doneBytes / it.totalBytes) * 100) : 0;
  const files = it.status === "done" && it.summary ? it.summary.files : it.doneFiles;
  const filesTotal = it.status === "done" && it.summary ? it.summary.files : it.totalFiles;
  const bytes = it.status === "done" && it.summary ? it.summary.bytes : it.doneBytes;
  const bytesTotal = it.status === "done" && it.summary ? it.summary.bytes : it.totalBytes;
  const status = it.status === "failed" ? `실패: ${it.error ?? ""}` : it.status === "done" && it.summary?.skipped ? `완료 (건너뜀 ${it.summary.skipped})` : STATUS[it.status];
  return (
    <div className={`transfer-row ${it.status}`}>
      <span className="transfer-label" title={it.label}>
        {it.label}
      </span>
      <div className={`transfer-bar${indeterminate ? " indeterminate" : ""}`}>
        <div style={{ width: `${pct}%` }} />
      </div>
      <span className="transfer-stat">
        {sizeText(bytes)} / {sizeText(bytesTotal)} · {files}/{filesTotal}개
      </span>
      <span className="transfer-status" title={status}>
        {status}
      </span>
      {(it.status === "queued" || it.status === "running") && <button onClick={() => cancel(it.id)}>취소</button>}
      {(it.status === "failed" || it.status === "canceled") && <button onClick={() => retry(it.id)}>재시도</button>}
    </div>
  );
}

export function TransferPanel({ tabId }: { tabId: string }) {
  const all = useTransfers((s) => s.items);
  const items = all.filter((i) => i.tabId === tabId);
  const [height, setHeight] = useState(140);
  if (!items.length)
    return (
      <div className="transfer-header">
        <span>전송 없음</span>
      </div>
    );
  return (
    <>
      {/* Splitter 는 아래로 끌면 size 가 커지므로 부호를 뒤집어 위로 끌면 패널이 커지게 한다 */}
      <Splitter dir="h" size={-height} onResize={(v) => setHeight(-v)} min={-500} max={-60} />
      <div className="transfer-header">
        <span>전송 {items.length}개</span>
        <button disabled={!items.some((i) => i.status === "done")} onClick={() => useTransfers.getState().clearDone(tabId)}>
          완료 항목 지우기
        </button>
      </div>
      <div className="transfer-list" style={{ height }}>
        {items.map((it) => (
          <Row key={it.id} it={it} />
        ))}
      </div>
    </>
  );
}

/** 충돌 질문을 한 번에 하나씩 띄운다. 탭과 무관하게 앱에 한 번만 둔다. */
export function TransferConflictHost() {
  const ask = useTransfers((s) => s.asks[0]);
  const [all, setAll] = useState(false);
  if (!ask) return null;
  const answer = (c: "overwrite" | "skip" | "rename") => {
    useTransfers.getState().answer(ask, c, all);
    setAll(false);
  };
  // 닫기(Esc·✕·배경) 는 질문을 건너뛰는 게 아니라 전송 전체를 중지한다
  const close = () => {
    setAll(false);
    useTransfers.getState().cancel(ask.job_id);
  };
  return (
    <Modal
      key={ask.ask_id}
      title="이미 있는 항목"
      width={460}
      onClose={close}
      footer={
        <>
          <button onClick={() => answer("overwrite")}>덮어쓰기</button>
          <button onClick={() => answer("skip")}>건너뛰기</button>
          <button onClick={() => answer("rename")}>이름 변경</button>
        </>
      }
    >
      <div style={{ wordBreak: "break-all" }}>
        {ask.dir ? "폴더" : "파일"}가 이미 있습니다: <b>{ask.path}</b>
      </div>
      <label className="label" style={{ marginTop: 10, display: "block" }}>
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> 모두 적용
      </label>
    </Modal>
  );
}
