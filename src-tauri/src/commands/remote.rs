use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::edit::{pick_files, pick_folder, pick_path};
use crate::error::{AppError, AppResult};
use crate::remote::picks::Pick;
use crate::remote::transfer::{self, Answer, Env, Job, Progress, TransferDone};
use crate::remote::text::{self, OpenText, SaveText, TextMeta};
use crate::remote::{known_hosts, ops, path, Entry, Stamp};
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

/// 질문이 끝나거나(응답) 중지돼 future 가 버려질 때 대기열에서 지운다
struct AskGuard {
    app: AppHandle,
    id: String,
}

impl Drop for AskGuard {
    fn drop(&mut self) {
        self.app.state::<AppState>().asks.lock().unwrap().remove(&self.id);
    }
}

#[derive(serde::Serialize, Clone)]
struct Conflict<'a> {
    job_id: &'a str,
    ask_id: &'a str,
    path: &'a str,
    dir: bool,
}

/// 업로드·다운로드 실행. 중지는 `cancel_query(job_id)`.
#[tauri::command]
pub async fn transfer_start(app: AppHandle, state: State<'_, AppState>, conn_id: String, job_id: String, job: Job) -> AppResult<TransferDone> {
    let r = state.remote(&conn_id).await?;
    if matches!(job, Job::Upload { .. }) {
        r.check_write()?;
    }
    let local = state.picks.get(job.pick_id())?;
    let emit = {
        let app = app.clone();
        Arc::new(move |p: Progress| {
            let _ = app.emit("transfer-progress", p);
        })
    };
    let ask = {
        let (app, job_id) = (app.clone(), job_id.clone());
        Arc::new(move |path: String| {
            let (app, job_id) = (app.clone(), job_id.clone());
            let fut: futures_util::future::BoxFuture<'static, AppResult<Answer>> = Box::pin(async move {
                let ask_id = uuid::Uuid::new_v4().simple().to_string();
                let (tx, rx) = tokio::sync::oneshot::channel();
                app.state::<AppState>().asks.lock().unwrap().insert(ask_id.clone(), tx);
                let _guard = AskGuard { app: app.clone(), id: ask_id.clone() };
                let _ = app.emit("transfer-conflict", Conflict { job_id: &job_id, ask_id: &ask_id, path: &path, dir: false });
                rx.await.map_err(|_| AppError::user("사용자가 중지했습니다."))
            });
            fut
        })
    };
    let env = Env { job_id: job_id.clone(), emit, ask };
    state
        .abortable(&job_id, async move {
            let s = r.session().await?;
            transfer::run(s, job, local, env).await
        })
        .await
}

#[tauri::command]
pub fn transfer_answer(state: State<'_, AppState>, ask_id: String, answer: Answer) -> AppResult<()> {
    let tx = state.asks.lock().unwrap().remove(&ask_id).ok_or_else(|| AppError::user("이미 처리되었거나 중지된 질문입니다."))?;
    tx.send(answer).map_err(|_| AppError::user("이미 중지된 작업입니다."))
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

#[tauri::command]
pub async fn remote_open_text(state: State<'_, AppState>, conn_id: String, path: String) -> AppResult<OpenText> {
    let r = state.remote(&conn_id).await?;
    let path = path::normalize(&path);
    r.run(|s| {
        let path = path.clone();
        Box::pin(async move { text::open_text(s, &path).await })
    })
    .await
}

#[tauri::command]
pub async fn remote_save_text(
    state: State<'_, AppState>,
    conn_id: String,
    path: String,
    meta: TextMeta,
    text: String,
    expect: Stamp,
    force: bool,
) -> AppResult<SaveText> {
    let r = state.remote(&conn_id).await?;
    r.check_write()?;
    let path = reject_root(&path)?;
    r.run(|s| {
        let (path, text, expect) = (path.clone(), text.clone(), expect.clone());
        Box::pin(async move { text::save_text(s, &path, meta, &text, &expect, force).await })
    })
    .await
}
