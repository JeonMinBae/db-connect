//! 업로드·다운로드 전송 엔진. Tauri 에 의존하지 않도록 이벤트·질문은 `Env` 콜백으로 받는다.
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};

use super::{ops, path, Session};
use crate::error::{AppError, AppResult};

#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Job {
    Upload { pick_id: String, dest_dir: String },
    /// pick 은 단일 파일 1개를 받을 때는 저장할 파일 경로, 그 외에는 대상 폴더
    Download { paths: Vec<String>, pick_id: String },
}

impl Job {
    pub fn pick_id(&self) -> &str {
        match self {
            Job::Upload { pick_id, .. } | Job::Download { pick_id, .. } => pick_id,
        }
    }
}

#[derive(Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Choice {
    Overwrite,
    Skip,
    Rename,
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Answer {
    pub choice: Choice,
    pub all: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct Progress {
    pub job_id: String,
    pub file: String,
    pub done_bytes: u64,
    pub total_bytes: u64,
    pub done_files: u64,
    pub total_files: u64,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct TransferDone {
    pub files: u64,
    pub bytes: u64,
    pub skipped: u64,
}

#[derive(Clone)]
pub struct Env {
    pub job_id: String,
    pub emit: Arc<dyn Fn(Progress) + Send + Sync>,
    /// 충돌 질문. 인자는 대상 경로. 중지되면 Err.
    pub ask: Arc<dyn Fn(String) -> BoxFuture<'static, AppResult<Answer>> + Send + Sync>,
}

const TICK: Duration = Duration::from_millis(200);

struct Prog {
    counter: Arc<AtomicU64>,
    file: Mutex<String>,
    done_files: AtomicU64,
    total_bytes: u64,
    total_files: u64,
}

impl Prog {
    fn snapshot(&self, job_id: &str) -> Progress {
        Progress {
            job_id: job_id.to_string(),
            file: self.file.lock().unwrap().clone(),
            done_bytes: self.counter.load(Ordering::Relaxed),
            total_bytes: self.total_bytes,
            done_files: self.done_files.load(Ordering::Relaxed),
            total_files: self.total_files,
        }
    }
}

struct Ctx {
    env: Env,
    prog: Arc<Prog>,
    policy: Option<Answer>,
    skipped: u64,
    /// 200ms 마다 진행 이벤트를 내는 태스크. 끝나거나 중지(drop)되면 Drop 에서 함께 멈춘다.
    ticker: tokio::task::JoinHandle<()>,
}

impl Drop for Ctx {
    fn drop(&mut self) {
        self.ticker.abort();
    }
}

impl Ctx {
    fn new(env: Env, total_bytes: u64, total_files: u64) -> Self {
        let prog = Arc::new(Prog { counter: Arc::new(AtomicU64::new(0)), file: Mutex::new(String::new()), done_files: AtomicU64::new(0), total_bytes, total_files });
        let ticker = {
            let (prog, env) = (prog.clone(), env.clone());
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(TICK).await;
                    (env.emit)(prog.snapshot(&env.job_id));
                }
            })
        };
        Self { env, prog, policy: None, skipped: 0, ticker }
    }

    fn begin(&self, file: &str) {
        *self.prog.file.lock().unwrap() = file.to_string();
    }

    fn file_done(&self) {
        self.prog.done_files.fetch_add(1, Ordering::Relaxed);
        (self.env.emit)(self.prog.snapshot(&self.env.job_id));
    }

    fn counter(&self) -> Arc<AtomicU64> {
        self.prog.counter.clone()
    }

    async fn ask(&self, target: &str) -> AppResult<Answer> {
        (self.env.ask)(target.to_string()).await
    }

    fn done(&self) -> TransferDone {
        TransferDone { files: self.prog.done_files.load(Ordering::Relaxed), bytes: self.prog.counter.load(Ordering::Relaxed), skipped: self.skipped }
    }
}

/// 대상이 이미 있을 때의 처리. None 이면 건너뛴다. 반환은 실제로 쓸 대상 이름.
async fn resolve_conflict(ctx: &mut Ctx, dir_has: impl Fn(&str) -> bool, name: &str, target: &str) -> AppResult<Option<String>> {
    if !dir_has(name) {
        return Ok(Some(name.to_string()));
    }
    let answer = match ctx.policy {
        Some(a) => a,
        None => {
            let a = ctx.ask(target).await?; // 이벤트 발행 후 oneshot 대기, sender drop = 중지
            if a.all {
                ctx.policy = Some(a);
            }
            a
        }
    };
    Ok(match answer.choice {
        Choice::Overwrite => Some(name.to_string()),
        Choice::Skip => {
            ctx.skipped += 1;
            None
        }
        Choice::Rename => Some(ops::unique_name(name, &dir_has)),
    })
}

/// `local` 은 job 의 pick_id 를 풀어 낸 로컬 경로들
pub async fn run(mut s: Session, job: Job, local: Vec<PathBuf>, env: Env) -> AppResult<TransferDone> {
    match job {
        Job::Upload { dest_dir, .. } => upload(&mut s, &path::normalize(&dest_dir), &local, env).await,
        Job::Download { paths, .. } => {
            let target = local.into_iter().next().ok_or_else(|| AppError::user("저장 위치가 없습니다."))?;
            download(&mut s, &paths, &target, env).await
        }
    }
}

struct LocalItem {
    src: PathBuf,
    /// 최상위 이름부터 시작하는 '/' 구분 상대경로
    rel: String,
    dir: bool,
    size: u64,
}

fn plan_upload(local: &[PathBuf]) -> AppResult<Vec<LocalItem>> {
    fn walk(dir: &Path, rel: &str, out: &mut Vec<LocalItem>) -> std::io::Result<()> {
        let mut es = std::fs::read_dir(dir)?.collect::<Result<Vec<_>, _>>()?;
        es.sort_by_key(|e| e.file_name());
        for e in es {
            let r = format!("{rel}/{}", e.file_name().to_string_lossy());
            let m = std::fs::metadata(e.path())?; // 링크는 대상 기준
            let is_link = e.file_type()?.is_symlink();
            out.push(LocalItem { src: e.path(), rel: r.clone(), dir: m.is_dir(), size: m.len() });
            // 폴더 링크는 안으로 들어가지 않는다 (순환 방지)
            if m.is_dir() && !is_link {
                walk(&e.path(), &r, out)?;
            }
        }
        Ok(())
    }
    let io = |p: &Path, e: std::io::Error| AppError::user(format!("{}: {e}", p.display()));
    let mut out = Vec::new();
    for p in local {
        let m = std::fs::metadata(p).map_err(|e| io(p, e))?;
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).ok_or_else(|| AppError::user("올릴 수 없는 경로입니다."))?;
        out.push(LocalItem { src: p.clone(), rel: name.clone(), dir: m.is_dir(), size: m.len() });
        if m.is_dir() {
            walk(p, &name, &mut out).map_err(|e| io(p, e))?;
        }
    }
    Ok(out)
}

/// 폴더당 한 번만 목록을 읽어 이름 집합을 캐시한다
async fn dir_names<'c>(cache: &'c mut HashMap<String, HashSet<String>>, s: &mut Session, dir: &str) -> AppResult<&'c HashSet<String>> {
    if !cache.contains_key(dir) {
        let names = s.list(dir).await?.into_iter().map(|e| e.name).collect();
        cache.insert(dir.to_string(), names);
    }
    Ok(&cache[dir])
}

async fn upload(s: &mut Session, dest: &str, local: &[PathBuf], env: Env) -> AppResult<TransferDone> {
    let plan = plan_upload(local)?;
    let total_files = plan.iter().filter(|i| !i.dir).count() as u64;
    let total_bytes = plan.iter().filter(|i| !i.dir).map(|i| i.size).sum();
    let mut ctx = Ctx::new(env, total_bytes, total_files);
    let mut cache: HashMap<String, HashSet<String>> = HashMap::new();

    for item in &plan {
        let (parent_rel, name) = item.rel.rsplit_once('/').unwrap_or(("", &item.rel));
        let remote_parent = path::join(dest, parent_rel);
        let target = path::join(&remote_parent, name);
        if item.dir {
            // 이미 있는 폴더는 질문 없이 합친다 (안의 파일은 각각 확인)
            match s.stat(&target).await? {
                Some((e, _)) if !e.dir => return Err(AppError::user(format!("같은 이름의 파일이 있어 폴더를 만들 수 없습니다: {target}"))),
                Some(_) => {}
                None => {
                    s.mkdir(&target).await?;
                    cache.insert(target.clone(), HashSet::new());
                }
            }
            continue;
        }
        let chosen = {
            let names = dir_names(&mut cache, s, &remote_parent).await?;
            resolve_conflict(&mut ctx, |n| names.contains(n), name, &target).await?
        };
        let Some(chosen) = chosen else { continue };
        let target = path::join(&remote_parent, &chosen);
        ctx.begin(&item.rel);
        let f = tokio::fs::File::open(&item.src).await.map_err(|e| AppError::user(format!("{}: {e}", item.src.display())))?;
        s.upload(&target, f, item.size, ctx.counter()).await?;
        if let Some(c) = cache.get_mut(&remote_parent) {
            c.insert(chosen);
        }
        ctx.file_done();
    }
    Ok(ctx.done())
}

/// 임시 파일 정리용. 중지로 future 가 drop 돼도 Drop 이 돌아 남지 않는다.
struct PartGuard(Option<PathBuf>);

impl PartGuard {
    fn disarm(&mut self) {
        self.0 = None;
    }
}

impl Drop for PartGuard {
    fn drop(&mut self) {
        if let Some(p) = self.0.take() {
            // 중지로 future 가 drop 되면 tokio 가 파일 핸들을 늦게 닫아 Windows 에서 삭제가 실패할 수 있다 → 잠시 재시도
            if std::fs::remove_file(&p).is_err() && p.exists() {
                std::thread::spawn(move || {
                    for _ in 0..20 {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                        if std::fs::remove_file(&p).is_ok() || !p.exists() {
                            break;
                        }
                    }
                });
            }
        }
    }
}

fn part_path(target: &Path) -> PathBuf {
    let mut n = target.as_os_str().to_os_string();
    n.push(".part");
    PathBuf::from(n)
}

async fn download_one(s: &mut Session, remote: &str, target: &Path, counter: Arc<AtomicU64>) -> AppResult<()> {
    let part = part_path(target);
    let mut guard = PartGuard(Some(part.clone()));
    let f = tokio::fs::File::create(&part).await.map_err(|e| AppError::user(format!("{}: {e}", part.display())))?;
    s.download(remote, f, counter).await?;
    // Windows 의 rename 은 기존 대상이 있으면 실패하므로 먼저 지운다
    if tokio::fs::try_exists(target).await.unwrap_or(false) {
        tokio::fs::remove_file(target).await.map_err(|e| AppError::user(format!("{}: {e}", target.display())))?;
    }
    tokio::fs::rename(&part, target).await.map_err(|e| AppError::user(format!("{}: {e}", target.display())))?;
    guard.disarm();
    Ok(())
}

struct RemoteItem {
    remote: String,
    rel: String,
    dir: bool,
    size: u64,
}

async fn download(s: &mut Session, paths: &[String], target: &Path, env: Env) -> AppResult<TransferDone> {
    let paths: Vec<String> = paths.iter().map(|p| path::normalize(p)).collect();
    let mut plan = Vec::new();
    for p in &paths {
        let (e, _) = s.stat(p).await?.ok_or_else(|| AppError::user(format!("원격 경로가 없습니다: {p}")))?;
        // 파일 하나만 받을 때는 저장 대화상자가 정한 파일 경로가 곧 대상이다 (덮어쓰기는 OS 에서 확인함)
        if paths.len() == 1 && !e.dir {
            let ctx = Ctx::new(env, e.size, 1);
            ctx.begin(&e.name);
            download_one(s, p, target, ctx.counter()).await?;
            ctx.file_done();
            return Ok(ctx.done());
        }
        let name = e.name.clone();
        plan.push(RemoteItem { remote: p.clone(), rel: name.clone(), dir: e.dir, size: e.size });
        if e.dir {
            for (rel, c) in ops::walk(s, p).await? {
                plan.push(RemoteItem { remote: path::join(p, &rel), rel: format!("{name}/{rel}"), dir: c.dir, size: c.size });
            }
        }
    }
    let total_files = plan.iter().filter(|i| !i.dir).count() as u64;
    let total_bytes = plan.iter().filter(|i| !i.dir).map(|i| i.size).sum();
    let mut ctx = Ctx::new(env, total_bytes, total_files);
    tokio::fs::create_dir_all(target).await.map_err(|e| AppError::user(format!("{}: {e}", target.display())))?;

    for item in &plan {
        let (parent_rel, name) = item.rel.rsplit_once('/').unwrap_or(("", &item.rel));
        let local_parent = if parent_rel.is_empty() { target.to_path_buf() } else { target.join(parent_rel) };
        if item.dir {
            let d = local_parent.join(name);
            tokio::fs::create_dir_all(&d).await.map_err(|e| AppError::user(format!("{}: {e}", d.display())))?;
            continue;
        }
        let shown = local_parent.join(name);
        let chosen = resolve_conflict(&mut ctx, |n| local_parent.join(n).exists(), name, &shown.to_string_lossy()).await?;
        let Some(chosen) = chosen else { continue };
        ctx.begin(&item.rel);
        download_one(s, &item.remote, &local_parent.join(chosen), ctx.counter()).await?;
        ctx.file_done();
    }
    Ok(ctx.done())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn part_guard_removes_file_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let part = part_path(&dir.path().join("a.bin"));
        assert!(part.to_string_lossy().ends_with("a.bin.part"));
        std::fs::write(&part, b"x").unwrap();
        drop(PartGuard(Some(part.clone())));
        assert!(!part.exists());

        std::fs::write(&part, b"x").unwrap();
        let mut g = PartGuard(Some(part.clone()));
        g.disarm();
        drop(g);
        assert!(part.exists());
    }
}
