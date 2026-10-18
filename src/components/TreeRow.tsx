import { useTree } from "../store/tree";

/** 사이드바 트리 한 줄 */
export function Row(props: {
  depth: number;
  open?: boolean;
  leaf?: boolean;
  onToggle?: () => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="tree-row"
      title={props.title}
      style={{ paddingLeft: 6 + props.depth * 14 }}
      onClick={props.onToggle}
      onDoubleClick={props.onDoubleClick}
      onContextMenu={props.onContextMenu}
    >
      <span className="twisty">{props.leaf ? "" : props.open ? "▾" : "▸"}</span>
      {props.children}
    </div>
  );
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
        open={open}
        onToggle={() => {
          useTree.getState().toggle(props.k, !open);
          if (!open) props.onOpen?.();
        }}
        onContextMenu={props.onContextMenu}
      >
        <span>📁</span>
        <span>{props.label}</span>
        {props.count !== undefined && <span className="type">{props.count}</span>}
      </Row>
      {open && props.children}
    </>
  );
}
