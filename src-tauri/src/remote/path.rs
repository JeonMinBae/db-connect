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
    }
}
