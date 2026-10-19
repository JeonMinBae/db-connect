use super::{path, Session};
use crate::error::AppResult;

/// 폴더면 하위부터 지운다. 반환: 지운 파일 수
pub async fn delete_tree(s: &mut Session, p: &str) -> AppResult<u64> {
    let Some((e, _)) = s.stat(p).await? else { return Ok(0) };
    // 폴더를 가리키는 링크는 대상 내용을 건드리지 않고 링크만 지운다
    if !e.dir || s.is_link(p).await? {
        s.remove_file(p).await?;
        return Ok(1);
    }
    let mut n = 0;
    for child in s.list(p).await? {
        n += Box::pin(delete_tree(s, &path::join(p, &child.name))).await?;
    }
    s.remove_dir(p).await?;
    Ok(n)
}
