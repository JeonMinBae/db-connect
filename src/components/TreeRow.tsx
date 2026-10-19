import { useEffect } from "react";
import { matchRanges, useSidebar } from "../store/sidebar";
import { useTree } from "../store/tree";

/**
 * 사이드바 트리 한 줄.
 * nodeId 가 있으면 클릭·키보드로 선택할 수 있다. 키보드 탐색(Sidebar)은 DOM 의 data-* 속성으로
 * 줄 순서·깊이·펼침 상태를 읽고, 펼치기는 click, Enter 는 dblclick 이벤트를 보내 처리한다.
 */
export function Row(props: {
  depth: number;
  nodeId?: string;
  open?: boolean;
  leaf?: boolean;
  onToggle?: () => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  title?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const { nodeId } = props;
  const selected = useSidebar((s) => !!nodeId && s.selected === nodeId);
  // 선택한 줄이 접히거나 지워져 사라지면 선택을 해제한다
  useEffect(
    () => () => {
      if (nodeId && useSidebar.getState().selected === nodeId) useSidebar.getState().select(null);
    },
    [nodeId],
  );
  let cls = "tree-row";
  if (props.className) cls += " " + props.className;
  if (selected) cls += " selected";
  return (
    <div
      className={cls}
      title={props.title}
      style={{ paddingLeft: 6 + props.depth * 14 }}
      data-node={nodeId}
      data-depth={props.depth}
      data-open={props.leaf ? undefined : props.open ? "1" : "0"}
      data-act={props.onToggle ? "" : undefined}
      data-dbl={props.onDoubleClick ? "" : undefined}
      onClick={() => {
        if (nodeId) useSidebar.getState().select(nodeId);
        props.onToggle?.();
      }}
      onDoubleClick={props.onDoubleClick}
      onContextMenu={(e) => {
        if (nodeId) useSidebar.getState().select(nodeId);
        props.onContextMenu?.(e);
      }}
    >
      <span className="twisty">{props.leaf ? "" : props.open ? "▾" : "▸"}</span>
      {props.children}
    </div>
  );
}

/** 사이드바 검색어와 일치하는 부분을 노란색으로 표시한 이름 */
export function Hl({ text }: { text: string }) {
  const q = useSidebar((s) => s.query);
  const ranges = q ? matchRanges(text, q) : [];
  if (!ranges.length) return <span>{text}</span>;
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const [a, b] of ranges) {
    if (a > at) parts.push(text.slice(at, a));
    parts.push(
      <mark key={a} className="hl">
        {text.slice(a, b)}
      </mark>,
    );
    at = b;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <span>{parts}</span>;
}

/** 펼침 상태를 트리 스토어에 두는 폴더 */
export function SubFolder(props: {
  k: string;
  label: string;
  count?: number | string;
  depth: number;
  defaultOpen?: boolean;
  onOpen?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  const open = useTree((s) => s.expanded[props.k] ?? !!props.defaultOpen);
  return (
    <>
      <Row
        depth={props.depth}
        nodeId={props.k}
        open={open}
        onToggle={() => {
          useTree.getState().toggle(props.k, !open);
          if (!open) props.onOpen?.();
        }}
        onContextMenu={props.onContextMenu}
      >
        <span>📁</span>
        <Hl text={props.label} />
        {props.count !== undefined && <span className="type">{props.count}</span>}
      </Row>
      {open && props.children}
    </>
  );
}
