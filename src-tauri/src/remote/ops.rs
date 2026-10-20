use super::{path, Entry, Session};
use crate::error::AppResult;

/// 폴더면 하위부터 지운다. 반환: 지운 파일 수
pub async fn delete_tree(s: &mut Session, p: &str) -> AppResult<u64> {
    let Some((e, _)) = s.stat(p).await? else { return Ok(0) };
    // 폴더를 가리키는 링크는 대상 내용을 건드리지 않고 링크만 지운다
    if !e.dir || s.is_link(p).await? {
        s.remove_file(p).await?;
        return Ok(1);
    }
    delete_dir(s, p).await
}

/// 목록에서 이미 알게 된 Entry 로 분기해 항목마다 stat(FTP 는 부모 목록 재조회)을 하지 않는다
async fn delete_dir(s: &mut Session, p: &str) -> AppResult<u64> {
    let mut n = 0;
    for child in s.list(p).await? {
        let cp = path::join(p, &child.name);
        if child.dir && !s.is_link(&cp).await? {
            n += Box::pin(delete_dir(s, &cp)).await?;
        } else {
            s.remove_file(&cp).await?;
            n += 1;
        }
    }
    s.remove_dir(p).await?;
    Ok(n)
}

/// root 아래 전체를 (root 기준 상대경로, Entry) 로 돌려준다. 폴더가 자식보다 앞에 온다.
/// 폴더를 가리키는 링크는 항목만 넣고 안으로 들어가지 않는다 (순환·범위 이탈 방지).
pub async fn walk(s: &mut Session, root: &str) -> AppResult<Vec<(String, Entry)>> {
    let mut out = Vec::new();
    walk_into(s, root, "", &mut out).await?;
    Ok(out)
}

async fn walk_into(s: &mut Session, root: &str, rel: &str, out: &mut Vec<(String, Entry)>) -> AppResult<()> {
    let dir = if rel.is_empty() { root.to_string() } else { path::join(root, rel) };
    let mut children = s.list(&dir).await?;
    children.sort_by(|a, b| a.name.cmp(&b.name));
    for e in children {
        let child_rel = if rel.is_empty() { e.name.clone() } else { format!("{rel}/{}", e.name) };
        let descend = e.dir && !s.is_link(&path::join(root, &child_rel)).await?;
        out.push((child_rel.clone(), e));
        if descend {
            Box::pin(walk_into(s, root, &child_rel, out)).await?;
        }
    }
    Ok(())
}

/// "a.txt" → "a (1).txt", "a (2).txt"… 확장자 없는 이름·dotfile 은 끝에 붙인다
pub fn unique_name(name: &str, exists: impl Fn(&str) -> bool) -> String {
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (1..).map(|n| format!("{stem} ({n}){ext}")).find(|c| !exists(c)).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unique_names() {
        let taken = ["a (1).txt"];
        assert_eq!(unique_name("a.txt", |c| taken.contains(&c)), "a (2).txt");
        assert_eq!(unique_name(".env", |_| false), ".env (1)");
        assert_eq!(unique_name("Makefile", |_| false), "Makefile (1)");
        assert_eq!(unique_name("x.tar.gz", |_| false), "x.tar (1).gz");
    }
}
