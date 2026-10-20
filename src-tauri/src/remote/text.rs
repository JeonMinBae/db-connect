//! 원격 텍스트 파일 열기/저장: 텍스트 판정, 인코딩 보존(BOM·CRLF·EUC-KR), 충돌 감지.
use serde::{Deserialize, Serialize};

use super::{Session, Stamp};
use crate::error::{AppError, AppResult};

pub const MAX_EDIT: u64 = 5 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Enc {
    Utf8,
    EucKr,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct TextMeta {
    pub encoding: Enc,
    pub bom: bool,
    pub crlf: bool,
}

#[derive(Serialize, Debug)]
#[serde(tag = "t")]
pub enum OpenText {
    Text { text: String, meta: TextMeta, stamp: Stamp },
    Binary,
    TooLarge { size: u64 },
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "t")]
pub enum SaveText {
    Saved { stamp: Stamp },
    Conflict,
}

/// 둘 다 etag 가 있으면 etag, 아니면 size+mtime 비교
pub fn same_stamp(a: &Stamp, b: &Stamp) -> bool {
    match (&a.etag, &b.etag) {
        (Some(x), Some(y)) => x == y,
        _ => a.size == b.size && a.mtime == b.mtime,
    }
}

/// None = 텍스트가 아님
pub fn decode(bytes: &[u8]) -> Option<(String, TextMeta)> {
    if bytes[..bytes.len().min(8192)].contains(&0) {
        return None;
    }
    let (body, bom) = match bytes.strip_prefix(b"\xEF\xBB\xBF") {
        Some(b) => (b, true),
        None => (bytes, false),
    };
    let (text, encoding) = match std::str::from_utf8(body) {
        Ok(s) => (s.to_string(), Enc::Utf8),
        Err(_) if !bom => (encoding_rs::EUC_KR.decode_without_bom_handling_and_without_replacement(body)?.into_owned(), Enc::EucKr),
        Err(_) => return None,
    };
    let crlf = text.find('\n').is_some_and(|i| i > 0 && text.as_bytes()[i - 1] == b'\r');
    Some((text.replace("\r\n", "\n"), TextMeta { encoding, bom, crlf }))
}

pub fn encode(text: &str, m: TextMeta) -> AppResult<Vec<u8>> {
    let text = if m.crlf { text.replace('\n', "\r\n") } else { text.to_string() };
    let mut out = if m.bom { b"\xEF\xBB\xBF".to_vec() } else { vec![] };
    match m.encoding {
        Enc::Utf8 => out.extend_from_slice(text.as_bytes()),
        Enc::EucKr => {
            let (bytes, _, had_errors) = encoding_rs::EUC_KR.encode(&text);
            if had_errors {
                let bad = text.chars().find(|c| encoding_rs::EUC_KR.encode(&c.to_string()).2).unwrap_or('?');
                return Err(AppError::user(format!("EUC-KR 로 저장할 수 없는 문자가 있습니다: {bad}")));
            }
            out.extend_from_slice(&bytes);
        }
    }
    Ok(out)
}

pub async fn open_text(s: &mut Session, path: &str) -> AppResult<OpenText> {
    let Some((e, stamp)) = s.stat(path).await? else { return Err(AppError::user("파일이 없습니다")) };
    if e.dir {
        return Err(AppError::user("폴더는 열 수 없습니다"));
    }
    if e.size > MAX_EDIT {
        return Ok(OpenText::TooLarge { size: e.size });
    }
    let bytes = s.read_all(path, MAX_EDIT).await?;
    Ok(match decode(&bytes) {
        Some((text, meta)) => OpenText::Text { text, meta, stamp },
        None => OpenText::Binary,
    })
}

/// 인코딩 오류는 원격을 건드리기 전에 낸다. force 가 아니면 열 때의 Stamp 와 다르거나 파일이 사라졌을 때 Conflict.
pub async fn save_text(s: &mut Session, path: &str, meta: TextMeta, text: &str, expect: &Stamp, force: bool) -> AppResult<SaveText> {
    let bytes = encode(text, meta)?;
    if !force {
        match s.stat(path).await? {
            Some((_, cur)) if same_stamp(&cur, expect) => {}
            _ => return Ok(SaveText::Conflict),
        }
    }
    s.write_all(path, &bytes).await?;
    let (_, stamp) = s.stat(path).await?.ok_or_else(|| AppError::Remote("저장 후 파일을 찾을 수 없습니다".into()))?;
    Ok(SaveText::Saved { stamp })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn roundtrips_preserve_bytes() {
        let cases: [&[u8]; 4] = [b"a\r\nb\r\n", b"\xEF\xBB\xBFhi\n", "한글\n".as_bytes(), b"\xC7\xD1\xB1\xDB\r\n"]; // 마지막 = EUC-KR "한글"
        for raw in cases {
            let (text, meta) = decode(raw).unwrap();
            assert!(!text.contains('\r'));
            assert_eq!(encode(&text, meta).unwrap(), raw);
        }
        assert_eq!(decode(b"\xC7\xD1\xB1\xDB").unwrap().1.encoding, Enc::EucKr);
    }
    #[test]
    fn binary_and_unencodable() {
        assert!(decode(b"PK\x03\x04\0\0").is_none());
        let m = TextMeta { encoding: Enc::EucKr, bom: false, crlf: false };
        assert!(encode("emoji 😀", m).is_err());
    }
}
