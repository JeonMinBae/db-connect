use tauri::{AppHandle, State};

use crate::commands::edit::{pick_files, pick_folder, pick_path};
use crate::error::{AppError, AppResult};
use crate::remote::picks::Pick;
use crate::remote::{known_hosts, ops, path, Entry};
use crate::state::AppState;

/// 사용자가 확인한 호스트 키를 저장한다 (이후 접속은 이 지문과 비교)
#[tauri::command]
pub fn remote_trust_host(state: State<'_, AppState>, host: String, port: u16, fingerprint: String) -> AppResult<()> {
    known_hosts::trust(&state.data_dir, &host, port, &fingerprint)
}

/// 개인키 파일을 백엔드 대화상자로 고른다. 취소하면 None.
#[tauri::command]
pub async fn pick_key_file(app: AppHandle) -> AppResult<Option<String>> {
    Ok(pick_path(&app, None).await?.map(|p| p.to_string_lossy().into_owned()))
}

/// 업로드할 로컬 파일·폴더를 대화상자로 고른다. 취소하면 None.
#[tauri::command]
pub async fn pick_upload(app: AppHandle, state: State<'_, AppState>, dirs: bool) -> AppResult<Option<Pick>> {
    let paths = pick_files(&app, dirs).await?;
    Ok((!paths.is_empty()).then(|| state.picks.register(paths)))
}

/// 내려받을 위치를 고른다. 파일명이 있으면 저장 대화상자, 없으면 폴더 대화상자. 취소하면 None.
#[tauri::command]
pub async fn pick_download_target(app: AppHandle, state: State<'_, AppState>, file_name: Option<String>) -> AppResult<Option<Pick>> {
    let p = match file_name {
        Some(n) => pick_path(&app, Some(n)).await?,
        None => pick_folder(&app).await?,
    };
    Ok(p.map(|p| state.picks.register(vec![p])))
}

#[tauri::command]
pub fn pick_release(state: State<'_, AppState>, pick_id: String) {
    state.picks.release(&pick_id);
}

/// 정규화한 경로를 돌려주되 루트는 거부한다 (쓰기 계열 공통)
fn reject_root(p: &str) -> AppResult<String> {
    let p = path::normalize(p);
    if p == "/" {
        Err(AppError::user("루트는 변경할 수 없습니다"))
    } else {
        Ok(p)
    }
}

#[tauri::command]
pub async fn remote_list(state: State<'_, AppState>, conn_id: String, path: String) -> AppResult<Vec<Entry>> {
    let r = state.remote(&conn_id).await?;
    let path = path::normalize(&path);
    let mut v = r
        .run(|s| {
            let path = path.clone();
            Box::pin(async move { s.list(&path).await })
        })
        .await?;
    v.sort_by_cached_key(|e| (!e.dir, e.name.to_lowercase()));
    Ok(v)
}

#[tauri::command]
pub async fn remote_mkdir(state: State<'_, AppState>, conn_id: String, path: String) -> AppResult<()> {
    let r = state.remote(&conn_id).await?;
    r.check_write()?;
    let path = reject_root(&path)?;
    r.run(|s| {
        let path = path.clone();
        Box::pin(async move { s.mkdir(&path).await })
    })
    .await
}

#[tauri::command]
pub async fn remote_rename(state: State<'_, AppState>, conn_id: String, from: String, to: String) -> AppResult<()> {
    let r = state.remote(&conn_id).await?;
    r.check_write()?;
    let (from, to) = (reject_root(&from)?, reject_root(&to)?);
    r.run(|s| {
        let (from, to) = (from.clone(), to.clone());
        Box::pin(async move { s.rename(&from, &to).await })
    })
    .await
}

#[tauri::command]
pub async fn remote_delete(state: State<'_, AppState>, conn_id: String, paths: Vec<String>) -> AppResult<u64> {
    let r = state.remote(&conn_id).await?;
    r.check_write()?;
    let paths = paths.iter().map(|p| reject_root(p)).collect::<AppResult<Vec<_>>>()?;
    r.run(|s| {
        let paths = paths.clone();
        Box::pin(async move {
            let mut n = 0;
            for p in &paths {
                n += ops::delete_tree(s, p).await?;
            }
            Ok(n)
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_is_rejected() {
        assert!(reject_root("/").is_err());
        assert!(reject_root("/a/..").is_err());
        assert!(reject_root("").is_err());
        assert_eq!(reject_root("/a//b/").unwrap(), "/a/b");
    }
}
