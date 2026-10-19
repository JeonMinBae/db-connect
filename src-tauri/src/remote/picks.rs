//! 로컬 경로 토큰. 대화상자·드롭으로 얻은 전체 경로는 백엔드에만 두고 웹뷰에는 id 와 이름만 보낸다.
use std::collections::HashMap;
use std::path::PathBuf;

use serde::Serialize;

use crate::error::{AppError, AppResult};

#[derive(Serialize, Clone, Debug)]
pub struct Pick {
    pub pick_id: String,
    pub names: Vec<String>,
}

// 윈도 이벤트 콜백이 동기라서 std Mutex 를 쓴다
#[derive(Default)]
pub struct PickRegistry(std::sync::Mutex<HashMap<String, Vec<PathBuf>>>);

impl PickRegistry {
    pub fn register(&self, paths: Vec<PathBuf>) -> Pick {
        let names = paths.iter().map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()).collect();
        let pick_id = uuid::Uuid::new_v4().simple().to_string();
        self.0.lock().unwrap().insert(pick_id.clone(), paths);
        Pick { pick_id, names }
    }

    pub fn get(&self, id: &str) -> AppResult<Vec<PathBuf>> {
        self.0.lock().unwrap().get(id).cloned().ok_or_else(|| AppError::user("선택한 파일 정보가 없습니다. 다시 선택하세요."))
    }

    pub fn release(&self, id: &str) {
        self.0.lock().unwrap().remove(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_get_release() {
        let r = PickRegistry::default();
        let p = r.register(vec![PathBuf::from(r"C:\tmp\a.txt"), PathBuf::from(r"C:\tmp\dir")]);
        assert_eq!(p.names, ["a.txt", "dir"]);
        assert_eq!(r.get(&p.pick_id).unwrap().len(), 2);
        r.release(&p.pick_id);
        assert!(r.get(&p.pick_id).is_err());
    }
}
