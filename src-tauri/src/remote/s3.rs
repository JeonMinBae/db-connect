//! S3 호환 스토리지 세션. 폴더는 키 접두어("a/b/")로 흉내 낸다.
use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;

use s3::bucket_ops::ListBucketsResponse;
use s3::creds::Credentials;
use s3::error::S3Error;
use s3::serde_types::ListBucketResult;
use s3::{Bucket, Region};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};

use super::io::Counting;
use super::{path, Entry, Stamp};
use crate::error::{AppError, AppResult};
use crate::store::config::ConnectionConfig;

#[derive(Debug, PartialEq)]
pub enum Loc {
    Buckets,
    Bucket { bucket: String, key: String },
}

/// key 는 폴더면 "a/b/" 처럼 끝 '/' 를 붙여 쓰는 쪽에서 결정한다. 여기서는 붙이지 않는다.
pub fn locate(bucket: &str, prefix: &str, path: &str) -> Loc {
    let rel = path::normalize(path).trim_start_matches('/').to_string();
    let join = |p: &str, r: &str| [p.trim_matches('/'), r].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join("/");
    if !bucket.is_empty() {
        return Loc::Bucket { bucket: bucket.into(), key: join(prefix, &rel) };
    }
    match rel.split_once('/') {
        None if rel.is_empty() => Loc::Buckets,
        None => Loc::Bucket { bucket: rel, key: String::new() },
        Some((b, k)) => Loc::Bucket { bucket: b.into(), key: k.into() },
    }
}

pub struct S3Session {
    /// 설정 리전. 버킷 목록과 리전 감지 실패 시에 쓴다
    region: Region,
    /// AWS 접속일 때만 있다. 버킷별 리전 감지용
    probe: Option<reqwest::Client>,
    creds: Credentials,
    path_style: bool,
    bucket: String,
    prefix: String,
    /// 버킷 미지정 접속에서 버킷마다 HTTP 클라이언트를 새로 만들지 않도록 재사용
    buckets: HashMap<String, Box<Bucket>>,
}

fn xml_tag(body: &str, tag: &str) -> Option<String> {
    let start = body.find(&format!("<{tag}>"))? + tag.len() + 2;
    let end = body[start..].find(&format!("</{tag}>"))? + start;
    Some(body[start..end].to_string())
}

fn s3_err(e: S3Error) -> AppError {
    match e {
        S3Error::HttpFailWithBody(status, body) => {
            let code = xml_tag(&body, "Code").unwrap_or_default();
            let msg = xml_tag(&body, "Message").unwrap_or_default();
            // 키가 틀린 경우만 인증 안내로 바꾼다 (권한 부족 AccessDenied 는 서버 메시지를 그대로 보여 준다)
            if status == 403 && matches!(code.as_str(), "InvalidAccessKeyId" | "SignatureDoesNotMatch") {
                return AppError::user("인증에 실패했습니다. Access Key·Secret Key 를 확인하세요.");
            }
            let detail = if code.is_empty() { body.trim().to_string() } else { format!("{code}: {msg}") };
            if code == "PermanentRedirect" {
                return AppError::Remote(format!("S3 오류 ({status}) 버킷이 다른 리전에 있습니다. 접속 설정의 리전을 버킷 리전으로 바꾸세요. ({detail})"));
            }
            AppError::Remote(format!("S3 오류 ({status}) {detail}").trim().to_string())
        }
        S3Error::Reqwest(re) if re.is_connect() || re.is_timeout() || re.is_request() || re.is_body() => AppError::Disconnected(re.to_string()),
        S3Error::Credentials(_) => AppError::user("Access Key·Secret Key 를 입력하세요."),
        e => AppError::Remote(e.to_string()),
    }
}

fn is_not_found(e: &S3Error) -> bool {
    matches!(e, S3Error::HttpFailWithBody(404, _))
}

/// 1970-01-01 기준 일수 (Howard Hinnant 의 days_from_civil)
fn epoch_days(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// "2024-05-01T12:34:56.000Z" → epoch ms
fn parse_iso(s: &str) -> Option<i64> {
    let (date, time) = s.trim_end_matches('Z').split_once('T')?;
    let mut d = date.split('-').map(|x| x.parse::<i64>());
    let (y, m, day) = (d.next()?.ok()?, d.next()?.ok()?, d.next()?.ok()?);
    let (hms, frac) = time.split_once('.').unwrap_or((time, "0"));
    let mut t = hms.split(':').map(|x| x.parse::<i64>());
    let (h, mi, sec) = (t.next()?.ok()?, t.next()?.ok()?, t.next()?.ok()?);
    let ms: i64 = format!("{:0<3}", &frac[..frac.len().min(3)]).parse().ok()?;
    Some(((epoch_days(y, m, day) * 24 + h) * 60 + mi) * 60_000 + sec * 1000 + ms)
}

/// HEAD 응답의 "Wed, 21 Oct 2015 07:28:00 GMT" → epoch ms
fn parse_http_date(s: &str) -> Option<i64> {
    let p: Vec<&str> = s.split_whitespace().collect();
    let [_, day, mon, year, time, ..] = p.as_slice() else { return None };
    let m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].iter().position(|x| x == mon)? as i64 + 1;
    let mut t = time.split(':').map(|x| x.parse::<i64>());
    let (h, mi, sec) = (t.next()?.ok()?, t.next()?.ok()?, t.next()?.ok()?);
    Some((((epoch_days(year.parse().ok()?, m, day.parse().ok()?) * 24 + h) * 60 + mi) * 60 + sec) * 1000)
}

/// 서버마다 따옴표·&quot; 표기가 달라 비교용으로 벗겨 낸다
fn clean_etag(e: Option<String>) -> Option<String> {
    e.map(|e| e.replace("&quot;", "").trim_matches('"').to_string()).filter(|e| !e.is_empty())
}

fn dir_entry(name: String) -> Entry {
    Entry { name, dir: true, size: 0, mtime: None, perm: None }
}

fn dir_stamp() -> Stamp {
    Stamp { size: 0, mtime: None, etag: None }
}

/// AWS 는 버킷이 다른 리전이면 301 을 돌려준다. 서명 없는 HEAD 에도 200·301·403 모두
/// x-amz-bucket-region 헤더로 실제 리전을 알려 주므로 키 없이 물어본다.
/// 점이 든 버킷 이름은 가상 호스트 방식이면 인증서가 맞지 않아 경로 방식으로 묻는다.
async fn detect_region(http: &reqwest::Client, bucket: &str) -> Option<String> {
    let r = http.head(format!("https://s3.amazonaws.com/{bucket}")).send().await.ok()?;
    r.headers().get("x-amz-bucket-region")?.to_str().ok().map(str::to_string)
}

fn aws_region(name: &str) -> Region {
    Region::Custom { region: name.to_string(), endpoint: format!("https://s3.{name}.amazonaws.com") }
}

/// S3 키 → 요청 경로 (라이브러리가 선행 '/' 를 떼고 URL 인코딩한다)
fn rp(key: &str) -> String {
    format!("/{key}")
}

impl S3Session {
    pub async fn open(cfg: &ConnectionConfig, secret: Option<&str>) -> AppResult<Self> {
        let region_name = if cfg.s3_region.trim().is_empty() { "us-east-1" } else { cfg.s3_region.trim() };
        let (region, probe) = match cfg.s3_endpoint.trim().trim_end_matches('/') {
            // 사이버덕처럼 전역 주소를 적은 경우도 AWS 로 본다
            "" | "https://s3.amazonaws.com" => {
                let http = reqwest::Client::builder().timeout(std::time::Duration::from_secs(10)).build().map_err(|e| AppError::Remote(e.to_string()))?;
                (aws_region(region_name), Some(http))
            }
            e => (Region::Custom { region: region_name.to_string(), endpoint: e.to_string() }, None),
        };
        let creds = Credentials::new(Some(cfg.user.as_str()), Some(secret.unwrap_or("")), None, None, None).map_err(|e| s3_err(e.into()))?;
        Ok(Self {
            region,
            probe,
            creds,
            path_style: cfg.s3_path_style,
            bucket: cfg.s3_bucket.trim().to_string(),
            prefix: cfg.s3_prefix.trim_matches('/').to_string(),
            buckets: HashMap::new(),
        })
    }

    fn loc(&self, p: &str) -> Loc {
        locate(&self.bucket, &self.prefix, p)
    }

    async fn bucket(&mut self, name: &str) -> AppResult<Box<Bucket>> {
        if let Some(b) = self.buckets.get(name) {
            return Ok(b.clone());
        }
        let (region, cache) = match &self.probe {
            Some(http) => match detect_region(http, name).await {
                Some(r) => (aws_region(&r), true),
                // 감지 실패(일시적 네트워크 오류 등)면 설정 리전으로 시도하고, 다음 요청 때 다시 감지한다
                None => (self.region.clone(), false),
            },
            None => (self.region.clone(), true),
        };
        let mut b = Bucket::new(name, region, self.creds.clone()).map_err(s3_err)?;
        if self.path_style {
            b = b.with_path_style();
        }
        if cache {
            self.buckets.insert(name.to_string(), b.clone());
        }
        Ok(b)
    }

    /// 버킷 안의 객체 위치만 허용한다 (버킷 목록·버킷 자체는 변경 불가)
    async fn target(&mut self, p: &str) -> AppResult<(Box<Bucket>, String)> {
        match self.loc(p) {
            Loc::Buckets => Err(AppError::user("버킷 목록에서는 변경할 수 없습니다")),
            Loc::Bucket { key, .. } if key.is_empty() => Err(AppError::user("버킷 자체는 만들거나 지우거나 이름을 바꿀 수 없습니다")),
            Loc::Bucket { bucket, key } => Ok((self.bucket(&bucket).await?, key)),
        }
    }

    async fn list_buckets(&self) -> AppResult<Vec<Entry>> {
        // 버킷 목록 요청은 라이브러리가 항상 path-style 로 보낸다
        let r: ListBucketsResponse = Bucket::list_buckets(self.region.clone(), self.creds.clone()).await.map_err(s3_err)?;
        Ok(r.buckets.bucket.into_iter().map(|b| Entry { mtime: parse_iso(&b.creation_date), ..dir_entry(b.name) }).collect())
    }

    pub async fn list(&mut self, p: &str) -> AppResult<Vec<Entry>> {
        let (bucket, key) = match self.loc(p) {
            Loc::Buckets => return self.list_buckets().await,
            Loc::Bucket { bucket, key } => (self.bucket(&bucket).await?, key),
        };
        let prefix = if key.is_empty() { String::new() } else { format!("{key}/") };
        // list 가 continuation token 으로 모든 페이지를 읽는다
        let pages: Vec<ListBucketResult> = bucket.list(prefix.clone(), Some("/".into())).await.map_err(s3_err)?;
        let mut out = Vec::new();
        for page in pages {
            for cp in page.common_prefixes.unwrap_or_default() {
                let name = cp.prefix.strip_prefix(&prefix).unwrap_or(&cp.prefix).trim_end_matches('/');
                if !name.is_empty() {
                    out.push(dir_entry(name.to_string()));
                }
            }
            for o in page.contents {
                let name = o.key.strip_prefix(&prefix).unwrap_or(&o.key);
                // 자기 자신인 "dir/" 마커(빈 이름)는 숨긴다
                if name.is_empty() || name.ends_with('/') {
                    continue;
                }
                out.push(Entry { name: name.to_string(), dir: false, size: o.size, mtime: parse_iso(&o.last_modified), perm: None });
            }
        }
        Ok(out)
    }

    pub async fn stat(&mut self, p: &str) -> AppResult<Option<(Entry, Stamp)>> {
        let (bucket, key) = match self.loc(p) {
            Loc::Buckets => return Ok(Some((dir_entry(String::new()), dir_stamp()))),
            Loc::Bucket { bucket, key } => (self.bucket(&bucket).await?, key),
        };
        let name = path::name(&path::normalize(p)).to_string();
        if key.is_empty() {
            return Ok(Some((dir_entry(name), dir_stamp())));
        }
        match bucket.head_object(rp(&key)).await {
            Ok((h, _)) => {
                let size = h.content_length.unwrap_or(0).max(0) as u64;
                let mtime = h.last_modified.as_deref().and_then(parse_http_date);
                let stamp = Stamp { size, mtime, etag: clean_etag(h.e_tag) };
                return Ok(Some((Entry { name, dir: false, size, mtime, perm: None }, stamp)));
            }
            Err(e) if is_not_found(&e) => {}
            Err(e) => return Err(s3_err(e)),
        }
        // 마커 객체도 이 접두어 목록에 잡힌다
        let (page, _) = bucket.list_page(format!("{key}/"), Some("/".into()), None, None, Some(1)).await.map_err(s3_err)?;
        let any = !page.contents.is_empty() || page.common_prefixes.is_some_and(|c| !c.is_empty());
        Ok(any.then(|| (dir_entry(name), dir_stamp())))
    }

    pub async fn mkdir(&mut self, p: &str) -> AppResult<()> {
        let (bucket, key) = self.target(p).await?;
        bucket.put_object(rp(&format!("{key}/")), b"").await.map_err(s3_err)?;
        Ok(())
    }

    /// 같은 버킷 안의 서버 복사. 원본 키는 헤더에 들어가므로 직접 인코딩해야 한다 (한글·공백).
    async fn copy(bucket: &Bucket, from: &str, to: &str) -> AppResult<()> {
        let enc = s3::signing::uri_encode(from, false);
        bucket.copy_object_internal(enc, rp(to)).await.map_err(s3_err)?;
        Ok(())
    }

    /// rust-s3 의 서버 복사는 원본 버킷이 항상 자기 자신이라 버킷 사이에는 내려받으며 바로 올린다.
    async fn copy_between(src: &Bucket, from: &str, dst: &Bucket, to: &str) -> AppResult<()> {
        if src.name() == dst.name() {
            return Self::copy(src, from, to).await;
        }
        // 빈 객체(폴더 마커 포함)는 길이를 모르는 스트림 업로드가 불안정해 직접 올린다
        let (h, _) = src.head_object(rp(from)).await.map_err(s3_err)?;
        if h.content_length.unwrap_or(0) <= 0 {
            dst.put_object(rp(to), b"").await.map_err(s3_err)?;
            return Ok(());
        }
        let (mut w, mut r) = tokio::io::duplex(256 * 1024);
        let down = async {
            src.get_object_to_writer(rp(from), &mut w).await.map_err(s3_err)?;
            w.shutdown().await.map_err(|e| AppError::Remote(e.to_string()))?; // EOF 를 알려야 업로드가 끝난다
            AppResult::Ok(())
        };
        let up = async {
            dst.put_object_stream(&mut r, rp(to)).await.map_err(s3_err)?;
            AppResult::Ok(())
        };
        tokio::try_join!(down, up)?;
        Ok(())
    }

    pub async fn chmod(&mut self, _p: &str, _mode: u32) -> AppResult<()> {
        Err(AppError::user("S3 는 권한 변경을 지원하지 않습니다"))
    }

    /// 객체 하나를 복사한다 (폴더는 호출자가 객체 단위로 푼다). 버킷이 다르면 스트리밍.
    pub async fn server_copy(&mut self, from: &str, to: &str) -> AppResult<()> {
        let (bucket, src) = self.target(from).await?;
        let (dst_bucket, dst) = self.target(to).await?;
        Self::copy_between(&bucket, &src, &dst_bucket, &dst).await
    }

    pub async fn rename(&mut self, from: &str, to: &str) -> AppResult<()> {
        let (bucket, src) = self.target(from).await?;
        let (dst_bucket, dst) = self.target(to).await?;
        if self.stat(from).await?.is_some_and(|(e, _)| e.dir) {
            let (sp, dp) = (format!("{src}/"), format!("{dst}/"));
            let keys: Vec<String> = bucket
                .list(sp.clone(), None)
                .await
                .map_err(s3_err)?
                .into_iter()
                .flat_map(|p| p.contents.into_iter().map(|o| o.key))
                .collect();
            for k in &keys {
                Self::copy_between(&bucket, k, &dst_bucket, &format!("{dp}{}", &k[sp.len()..])).await?;
            }
            // 복사가 모두 끝난 뒤에 지워 중간에 실패해도 원본이 남게 한다
            for k in &keys {
                bucket.delete_object(rp(k)).await.map_err(s3_err)?;
            }
        } else {
            Self::copy_between(&bucket, &src, &dst_bucket, &dst).await?;
            bucket.delete_object(rp(&src)).await.map_err(s3_err)?;
        }
        Ok(())
    }

    pub async fn remove_file(&mut self, p: &str) -> AppResult<()> {
        let (bucket, key) = self.target(p).await?;
        bucket.delete_object(rp(&key)).await.map_err(s3_err)?;
        Ok(())
    }

    /// 마커 객체만 지운다 (없어도 S3 는 성공). 하위 객체는 ops::delete_tree 가 먼저 지운다.
    pub async fn remove_dir(&mut self, p: &str) -> AppResult<()> {
        let (bucket, key) = self.target(p).await?;
        bucket.delete_object(rp(&format!("{key}/"))).await.map_err(s3_err)?;
        Ok(())
    }

    pub async fn is_link(&mut self, _p: &str) -> AppResult<bool> {
        Ok(false)
    }

    pub async fn upload(&mut self, p: &str, reader: impl AsyncRead + Unpin + Send, counter: Arc<AtomicU64>) -> AppResult<()> {
        let (bucket, key) = self.target(p).await?;
        let mut r = Counting::new(reader, counter);
        bucket.put_object_stream(&mut r, rp(&key)).await.map_err(s3_err)?;
        Ok(())
    }

    /// 객체의 Content-Type (없으면 None)
    pub async fn content_type(&mut self, p: &str) -> AppResult<Option<String>> {
        let (bucket, key) = self.target(p).await?;
        let (h, _) = bucket.head_object(rp(&key)).await.map_err(s3_err)?;
        Ok(h.content_type.filter(|c| !c.is_empty()))
    }

    /// Content-Type 을 지정해 올린다. 길이를 모르는 스트림 업로드는 0바이트에서 불안정해 첫 바이트를 보고 빈 파일은 한 번에 PUT 한다.
    pub async fn upload_typed(&mut self, p: &str, reader: impl AsyncRead + Unpin + Send, counter: Arc<AtomicU64>, content_type: &str) -> AppResult<()> {
        let (bucket, key) = self.target(p).await?;
        let mut r = BufReader::new(Counting::new(reader, counter));
        if r.fill_buf().await.map_err(|e| AppError::Remote(e.to_string()))?.is_empty() {
            bucket.put_object_with_content_type(rp(&key), b"", content_type).await.map_err(s3_err)?;
        } else {
            bucket.put_object_stream_with_content_type(&mut r, rp(&key), content_type).await.map_err(s3_err)?;
        }
        Ok(())
    }

    pub async fn download(&mut self, p: &str, writer: impl AsyncWrite + Unpin + Send, counter: Arc<AtomicU64>) -> AppResult<()> {
        let (bucket, key) = self.target(p).await?;
        let mut w = Counting::new(writer, counter);
        bucket.get_object_to_writer(rp(&key), &mut w).await.map_err(s3_err)?;
        w.flush().await.map_err(|e| AppError::Remote(e.to_string()))
    }

    pub async fn read_all(&mut self, p: &str, limit: u64) -> AppResult<Vec<u8>> {
        let (bucket, key) = self.target(p).await?;
        let (h, _) = bucket.head_object(rp(&key)).await.map_err(s3_err)?;
        if h.content_length.unwrap_or(0).max(0) as u64 > limit {
            return Err(AppError::user("파일이 너무 큽니다"));
        }
        let bytes = bucket.get_object(rp(&key)).await.map_err(s3_err)?.to_vec();
        if bytes.len() as u64 > limit {
            return Err(AppError::user("파일이 너무 큽니다"));
        }
        Ok(bytes)
    }

    pub async fn write_all(&mut self, p: &str, bytes: &[u8]) -> AppResult<()> {
        let (bucket, key) = self.target(p).await?;
        bucket.put_object(rp(&key), bytes).await.map_err(s3_err)?;
        Ok(())
    }

    /// 파일에 대한 GET 사전서명 URL
    pub async fn presign(&mut self, p: &str, expires_secs: u32) -> AppResult<String> {
        let (bucket, key) = self.target(p).await?;
        match self.stat(p).await? {
            Some((e, _)) if !e.dir => {}
            _ => return Err(AppError::user("파일만 사전서명 URL 을 만들 수 있습니다")),
        }
        bucket.presign_get(rp(&key), expires_secs, None).await.map_err(s3_err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locates() {
        assert_eq!(locate("", "", "/"), Loc::Buckets);
        assert_eq!(locate("", "", "/bk"), Loc::Bucket { bucket: "bk".into(), key: "".into() });
        assert_eq!(locate("", "", "/bk/a/b.txt"), Loc::Bucket { bucket: "bk".into(), key: "a/b.txt".into() });
        assert_eq!(locate("bk", "base/", "/a"), Loc::Bucket { bucket: "bk".into(), key: "base/a".into() });
        assert_eq!(locate("bk", "", "/"), Loc::Bucket { bucket: "bk".into(), key: "".into() });
    }

    #[test]
    fn parses_dates() {
        assert_eq!(parse_iso("2024-05-01T12:34:56.789Z"), Some(1714566896789));
        assert_eq!(parse_http_date("Wed, 01 May 2024 12:34:56 GMT"), Some(1714566896000));
        assert_eq!(clean_etag(Some("\"abc\"".into())), Some("abc".into()));
    }
}
