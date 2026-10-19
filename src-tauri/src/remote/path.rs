/// 원격 경로를 "/a/b" 형태로 정규화한다. ".." 는 루트 위로 올라가지 않는다.
pub fn normalize(p: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    format!("/{}", parts.join("/"))
}

pub fn join(dir: &str, name: &str) -> String {
    normalize(&format!("{dir}/{name}"))
}

pub fn parent(p: &str) -> String {
    normalize(&format!("{}/..", normalize(p)))
}

/// dest 가 src 자신이거나 그 하위인지 (폴더를 자기 안으로 옮기지 못하게)
pub fn is_inside(dest: &str, src: &str) -> bool {
    let (dest, src) = (normalize(dest), normalize(src));
    src == "/" || dest == src || dest.starts_with(&format!("{src}/"))
}

pub fn name(p: &str) -> &str {
    p.rsplit('/').next().unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes() {
        assert_eq!(normalize(""), "/");
        assert_eq!(normalize("a//b/./c/"), "/a/b/c");
        assert_eq!(normalize("/a/../../b"), "/b");
        assert_eq!(join("/a", "b c"), "/a/b c");
        assert_eq!(parent("/a/b"), "/a");
        assert_eq!(parent("/"), "/");
        assert_eq!(name("/a/b.txt"), "b.txt");
        assert!(is_inside("/a/b", "/a"));
        assert!(is_inside("/a", "/a/"));
        assert!(!is_inside("/ab", "/a"));
        assert!(!is_inside("/a", "/a/b"));
    }
}
