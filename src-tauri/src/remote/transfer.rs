//! 업로드·다운로드 전송 엔진. Tauri 에 의존하지 않도록 이벤트·질문은 `Env` 콜백으로 받는다.
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use super::{ops, path, Session};
use crate::error::{AppError, AppResult};

#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Job {
    Upload { pick_id: String, dest_dir: String },
    /// pick 은 단일 파일 1개를 받을 때는 저장할 파일 경로, 그 외에는 대상 폴더
    Download { paths: Vec<String>, pick_id: String },
    /// 같은 접속 안에서의 복사. 로컬 pick 이 없다.
    Copy { paths: Vec<String>, dest_dir: String },
    /// 다른 접속으로 복사. 원본은 transfer_start 의 conn_id, 대상 세션은 run 의 opener 가 연다.
    CrossCopy {
        paths: Vec<String>,
        dest_conn_id: String,
        dest_dir: String,
        /// 두 접속이 같은 파일 공간인지 (transfer_start 가 설정, 웹뷰는 보내지 않는다)
        #[serde(skip)]
        same_space: bool,
    },
}

impl Job {
    pub fn pick_id(&self) -> Option<&str> {
        match self {
            Job::Upload { pick_id, .. } | Job::Download { pick_id, .. } => Some(pick_id),
            Job::Copy { .. } | Job::CrossCopy { .. } => None,
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
    /// 충돌 질문. 인자는 (대상 경로, 폴더 여부). 중지되면 Err.
    pub ask: Arc<dyn Fn(String, bool) -> BoxFuture<'static, AppResult<Answer>> + Send + Sync>,
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

    async fn ask(&self, target: &str, dir: bool) -> AppResult<Answer> {
        (self.env.ask)(target.to_string(), dir).await
    }

    fn done(&self) -> TransferDone {
        TransferDone { files: self.prog.done_files.load(Ordering::Relaxed), bytes: self.prog.counter.load(Ordering::Relaxed), skipped: self.skipped }
    }
}

/// 대상이 이미 있을 때의 처리. None 이면 건너뛴다. 반환은 실제로 쓸 대상 이름.
async fn resolve_conflict(ctx: &mut Ctx, dir_has: impl Fn(&str) -> bool, name: &str, target: &str, dir: bool) -> AppResult<Option<String>> {
    if !dir_has(name) {
        return Ok(Some(name.to_string()));
    }
    let answer = match ctx.policy {
        Some(a) => a,
        None => {
            let a = ctx.ask(target, dir).await?; // 이벤트 발행 후 oneshot 대기, sender drop = 중지
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

/// Copy 에서는 FTP/SFTP 스트리밍용 두 번째 세션, CrossCopy 에서는 대상 접속 세션을 여는 함수 (필요할 때만 한 번 호출)
pub type Opener = Box<dyn FnOnce() -> BoxFuture<'static, AppResult<Session>> + Send>;

/// `local` 은 job 의 pick_id 를 풀어 낸 로컬 경로들
pub async fn run(mut s: Session, job: Job, local: Vec<PathBuf>, env: Env, open_second: Option<Opener>) -> AppResult<TransferDone> {
    match job {
        Job::Copy { paths, dest_dir } => copy(Sides::Same { s: &mut s, copier: Copier { second: None, opener: open_second } }, &paths, &path::normalize(&dest_dir), env).await,
        Job::CrossCopy { paths, dest_dir, same_space, .. } => {
            let open = open_second.ok_or_else(|| AppError::user("대상 접속을 열 수 없습니다."))?;
            let mut dst = open().await?;
            copy(Sides::Cross { src: &mut s, dst: &mut dst, same_space },&paths, &path::normalize(&dest_dir), env).await
        }
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
            ensure_dir(s, &mut cache, &target).await?;
            continue;
        }
        let chosen = {
            let names = dir_names(&mut cache, s, &remote_parent).await?;
            resolve_conflict(&mut ctx, |n| names.contains(n), name, &target, false).await?
        };
        let Some(chosen) = chosen else { continue };
        let target = path::join(&remote_parent, &chosen);
        ctx.begin(&item.rel);
        let f = tokio::fs::File::open(&item.src).await.map_err(|e| AppError::user(format!("{}: {e}", item.src.display())))?;
        s.upload(&target, f, ctx.counter()).await?;
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

/// 같은 폴더에 작업마다 다른 임시 이름을 쓴다 (기존 사용자 파일을 건드리지 않기 위해)
fn part_path(target: &Path) -> PathBuf {
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let id = &uuid::Uuid::new_v4().simple().to_string()[..8];
    target.with_file_name(format!(".{name}.{id}.part"))
}

/// 원격 이름은 신뢰할 수 없으므로 로컬 경로 한 칸으로 써도 안전한지 확인한다.
/// ':' 는 드라이브 문자·NTFS 대체 스트림, 끝의 '.'·공백은 Windows 가 조용히 떼어 내 다른 이름이 된다.
fn safe_local_segment(name: &str) -> AppResult<&str> {
    let bad = name.is_empty()
        || name == "."
        || name == ".."
        || name.contains(['\\', '/', ':'])
        || name.chars().any(|c| c.is_control())
        || name.ends_with(['.', ' ']);
    if bad {
        return Err(AppError::user(format!("안전하지 않은 원격 파일 이름이라 받을 수 없습니다: {name:?}")));
    }
    Ok(name)
}

async fn download_one(s: &mut Session, remote: &str, target: &Path, counter: Arc<AtomicU64>) -> AppResult<()> {
    let part = part_path(target);
    let f = tokio::fs::OpenOptions::new().write(true).create_new(true).open(&part).await.map_err(|e| AppError::user(format!("{}: {e}", part.display())))?;
    let mut guard = PartGuard(Some(part.clone()));
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
        let name = safe_local_segment(&e.name)?.to_string();
        plan.push(RemoteItem { remote: p.clone(), rel: name.clone(), dir: e.dir, size: e.size });
        if e.dir {
            for (rel, c) in ops::walk(s, p).await? {
                rel.split('/').try_for_each(|seg| safe_local_segment(seg).map(|_| ()))?;
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
            if !d.starts_with(target) {
                return Err(AppError::user(format!("선택한 폴더 밖에는 저장할 수 없습니다: {}", item.rel)));
            }
            tokio::fs::create_dir_all(&d).await.map_err(|e| AppError::user(format!("{}: {e}", d.display())))?;
            continue;
        }
        let shown = local_parent.join(name);
        let chosen = resolve_conflict(&mut ctx, |n| local_parent.join(n).exists(), name, &shown.to_string_lossy(), false).await?;
        let Some(chosen) = chosen else { continue };
        let local = local_parent.join(chosen);
        if !local.starts_with(target) {
            return Err(AppError::user(format!("선택한 폴더 밖에는 저장할 수 없습니다: {}", item.rel)));
        }
        ctx.begin(&item.rel);
        download_one(s, &item.remote, &local, ctx.counter()).await?;
        ctx.file_done();
    }
    Ok(ctx.done())
}

/// FTP/SFTP 는 서버 복사 명령이 없어 세션 두 개로 내려받는 즉시 올린다 (임시 파일 없음)
/// `ct` 는 대상이 S3 일 때만 쓴다.
async fn stream_copy(src: &mut Session, dst: &mut Session, from: &str, to: &str, counter: Arc<AtomicU64>, ct: Option<&str>) -> AppResult<()> {
    let (mut w, r) = tokio::io::duplex(256 * 1024);
    let down = async {
        src.download(from, &mut w, Arc::new(AtomicU64::new(0))).await?;
        w.shutdown().await.map_err(|e| AppError::Remote(e.to_string()))?; // EOF 를 알려야 업로드가 끝난다
        AppResult::Ok(())
    };
    let up = async {
        match ct {
            Some(c) => dst.upload_typed(to, r, counter, c).await,
            None => dst.upload(to, r, counter).await,
        }
    };
    tokio::try_join!(down, up)?;
    Ok(())
}

/// 복사의 원본·대상. Same 은 한 세션이 둘 다 맡고, Cross 는 접속이 다르다.
enum Sides<'a> {
    Same { s: &'a mut Session, copier: Copier },
    /// same_space: 다른 접속이지만 같은 서버·계정이라 같은 경로가 같은 파일이다
    Cross { src: &'a mut Session, dst: &'a mut Session, same_space: bool },
}

impl Sides<'_> {
    fn src(&mut self) -> &mut Session {
        match self {
            Sides::Same { s, .. } => s,
            Sides::Cross { src, .. } => src,
        }
    }

    fn dst(&mut self) -> &mut Session {
        match self {
            Sides::Same { s, .. } => s,
            Sides::Cross { dst, .. } => dst,
        }
    }

    async fn file(&mut self, ctx: &mut Ctx, from: &str, to: &str, size: u64, shown: &str) -> AppResult<()> {
        match self {
            Sides::Same { s, copier } => copier.file(ctx, s, from, to, size, shown).await,
            // 자기 자신 위로 덮어쓰면 업로드가 원본을 비운 뒤 읽게 되므로 건너뛴다
            Sides::Cross { same_space: true, .. } if from == to => {
                ctx.skipped += 1;
                Ok(())
            }
            Sides::Cross { src, dst, .. } => cross_file(ctx, src, dst, from, to, shown).await,
        }
    }
}

/// 대상 S3 객체의 Content-Type: 원본 S3 값이 있으면 그대로, 없으면 원본 확장자로 추정
fn copy_content_type(src_ct: Option<String>, from: &str) -> String {
    src_ct.unwrap_or_else(|| mime_guess::from_path(from).first_or_octet_stream().to_string())
}

/// 부분 파일은 지우지 않는다(요구사항). 대신 어디에 남았을 수 있는지 오류에 붙인다.
async fn cross_file(ctx: &mut Ctx, src: &mut Session, dst: &mut Session, from: &str, to: &str, shown: &str) -> AppResult<()> {
    ctx.begin(shown);
    let ct = if matches!(dst, Session::S3(_)) { Some(copy_content_type(src.content_type(from).await?, from)) } else { None };
    stream_copy(src, dst, from, to, ctx.counter(), ct.as_deref())
        .await
        .map_err(|e| AppError::user(format!("{e} (대상에 쓰다 만 파일이 남았을 수 있습니다: {to})")))?;
    ctx.file_done();
    Ok(())
}

struct Copier {
    second: Option<Session>,
    opener: Option<Opener>,
}

impl Copier {
    async fn file(&mut self, ctx: &mut Ctx, s: &mut Session, from: &str, to: &str, size: u64, shown: &str) -> AppResult<()> {
        // 자기 자신 위로 덮어쓰면 내용이 비워지므로 건너뛴다
        if from == to {
            ctx.skipped += 1;
            return Ok(());
        }
        ctx.begin(shown);
        if matches!(s, Session::S3(_)) {
            s.server_copy(from, to).await?;
            ctx.prog.counter.fetch_add(size, Ordering::Relaxed);
        } else {
            if self.second.is_none() {
                let open = self.opener.take().ok_or_else(|| AppError::user("복사용 두 번째 접속을 열 수 없습니다."))?;
                self.second = Some(open().await?);
            }
            stream_copy(s, self.second.as_mut().unwrap(), from, to, ctx.counter(), None).await?;
        }
        ctx.file_done();
        Ok(())
    }
}

/// 없으면 만들고, 같은 이름의 파일이 있으면 오류. 있는 폴더는 합친다.
async fn ensure_dir(s: &mut Session, cache: &mut HashMap<String, HashSet<String>>, target: &str) -> AppResult<()> {
    match s.stat(target).await? {
        Some((e, _)) if !e.dir => Err(AppError::user(format!("같은 이름의 파일이 있어 폴더를 만들 수 없습니다: {target}"))),
        Some(_) => Ok(()),
        None => {
            s.mkdir(target).await?;
            cache.insert(target.to_string(), HashSet::new());
            Ok(())
        }
    }
}

async fn copy(mut sides: Sides<'_>, paths: &[String], dest: &str, env: Env) -> AppResult<TransferDone> {
    let same = matches!(sides, Sides::Same { .. });
    let mut tops = Vec::new();
    for p in paths {
        let p = path::normalize(p);
        if p == "/" {
            return Err(AppError::user("루트는 복사할 수 없습니다"));
        }
        let (e, _) = sides.src().stat(&p).await?.ok_or_else(|| AppError::user(format!("원격 경로가 없습니다: {p}")))?;
        // 접속이 다르면 경로 공간이 달라 겹치지 않는다
        if same && e.dir && path::is_inside(dest, &p) {
            return Err(AppError::user(format!("폴더를 자기 자신 안으로 복사할 수 없습니다: {p}")));
        }
        let kids = if e.dir { ops::walk(sides.src(), &p).await? } else { Vec::new() };
        tops.push((p, e, kids));
    }
    let files = || tops.iter().flat_map(|(_, e, k)| std::iter::once(e).chain(k.iter().map(|(_, c)| c))).filter(|e| !e.dir);
    let (total_files, total_bytes) = (files().count() as u64, files().map(|e| e.size).sum());
    let mut ctx = Ctx::new(env, total_bytes, total_files);
    let mut cache: HashMap<String, HashSet<String>> = HashMap::new();

    for (src, e, kids) in &tops {
        let chosen = {
            let names = dir_names(&mut cache, sides.dst(), dest).await?;
            resolve_conflict(&mut ctx, |n| names.contains(n), &e.name, &path::join(dest, &e.name), e.dir).await?
        };
        let Some(chosen) = chosen else { continue };
        let top = path::join(dest, &chosen);
        if let Some(c) = cache.get_mut(dest) {
            c.insert(chosen.clone());
        }
        if !e.dir {
            sides.file(&mut ctx, src, &top, e.size, &e.name).await?;
            continue;
        }
        ensure_dir(sides.dst(), &mut cache, &top).await?;
        for (rel, c) in kids {
            let target = path::join(&top, rel);
            if c.dir {
                ensure_dir(sides.dst(), &mut cache, &target).await?;
                continue;
            }
            let (parent_rel, name) = rel.rsplit_once('/').unwrap_or(("", rel));
            let tparent = path::join(&top, parent_rel);
            let picked = {
                let names = dir_names(&mut cache, sides.dst(), &tparent).await?;
                resolve_conflict(&mut ctx, |n| names.contains(n), name, &target, false).await?
            };
            let Some(picked) = picked else { continue };
            sides.file(&mut ctx, &path::join(src, rel), &path::join(&tparent, &picked), c.size, &format!("{}/{rel}", e.name)).await?;
            if let Some(set) = cache.get_mut(&tparent) {
                set.insert(picked);
            }
        }
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
        let fname = part.file_name().unwrap().to_string_lossy().into_owned();
        assert!(fname.starts_with(".a.bin.") && fname.ends_with(".part"));
        assert_ne!(part, part_path(&dir.path().join("a.bin")));
        std::fs::write(&part, b"x").unwrap();
        drop(PartGuard(Some(part.clone())));
        assert!(!part.exists());

        std::fs::write(&part, b"x").unwrap();
        let mut g = PartGuard(Some(part.clone()));
        g.disarm();
        drop(g);
        assert!(part.exists());
    }

    #[test]
    fn content_type_rule() {
        assert_eq!(copy_content_type(Some("text/csv; charset=utf-8".into()), "/a/data"), "text/csv; charset=utf-8");
        assert_eq!(copy_content_type(None, "/a/b.json"), "application/json");
        assert_eq!(copy_content_type(None, "/a/noext"), "application/octet-stream");
    }

    #[test]
    fn crosscopy_job_from_json() {
        // same_space 는 웹뷰가 보내도 무시된다 (백엔드가 접속 설정으로 정한다)
        let j: Job = serde_json::from_str(r#"{"kind":"crosscopy","paths":["/a"],"dest_conn_id":"c2","dest_dir":"/b","same_space":true}"#).unwrap();
        assert!(matches!(j, Job::CrossCopy { ref dest_conn_id, same_space: false, .. } if dest_conn_id == "c2"));
        assert!(j.pick_id().is_none());
    }

    #[test]
    fn same_file_space_rule() {
        use crate::store::config::{ConnectionConfig, Driver};
        let sftp = ConnectionConfig { id: "a".into(), driver: Driver::Sftp, host: "Example.com".into(), port: 22, user: "u".into(), ..Default::default() };
        assert!(super::super::same_file_space(&sftp, &ConnectionConfig { id: "b".into(), host: "example.com".into(), ..sftp.clone() }));
        assert!(!super::super::same_file_space(&sftp, &ConnectionConfig { user: "other".into(), ..sftp.clone() }));
        assert!(!super::super::same_file_space(&sftp, &ConnectionConfig { port: 2222, ..sftp.clone() }));
        let s3 = ConnectionConfig { driver: Driver::S3, ..sftp.clone() };
        assert!(!super::super::same_file_space(&s3, &s3.clone()));
    }

    #[test]
    fn local_segments() {
        for ok in ["ok.txt", "한글.txt", ".env", "a b.txt"] {
            assert_eq!(safe_local_segment(ok).unwrap(), ok);
        }
        for bad in ["", ".", "..", "..\\..\\x", "a\\b", "a/b", "C:x", "file.txt:stream", "a\0b", "a\nb", "name.", "name "] {
            assert!(safe_local_segment(bad).is_err(), "{bad:?}");
        }
    }

    #[tokio::test]
    async fn part_create_new_keeps_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let part = part_path(&dir.path().join("a.bin"));
        std::fs::write(&part, b"mine").unwrap();
        let r = tokio::fs::OpenOptions::new().write(true).create_new(true).open(&part).await;
        assert!(r.is_err());
        assert_eq!(std::fs::read(&part).unwrap(), b"mine");
    }
}
