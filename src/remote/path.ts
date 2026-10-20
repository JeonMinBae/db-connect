/** Rust remote/path.rs 와 같은 규칙: "/a/b" 로 정규화하고 ".." 는 루트 위로 올라가지 않는다 */
export function normalize(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}

export const join = (dir: string, name: string) => normalize(`${dir}/${name}`);

export const parent = (p: string) => normalize(`${normalize(p)}/..`);

export const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** p 가 dir 자신이거나 그 하위인지 */
export const isUnder = (p: string, dir: string) => {
  const [q, d] = [normalize(p), normalize(dir)];
  return q === d || q.startsWith(d === "/" ? "/" : `${d}/`);
};
