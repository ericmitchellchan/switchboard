// Knowledge Base backend (T6) — list/read/write over the personal-kb checkout.
//
// Root resolution order (resolve_kb_root):
//   1. env `SWITCHBOARD_KB_PATH`          — per-launch override
//   2. config `kb_path`                   — %APPDATA%/switchboard/config.json
//   3. DEFAULT_KB_PATH                    — Eric's personal-kb checkout
// The hardcoded default is deliberate: Switchboard is a personal
// single-machine app and the KB lives at one known path on this machine.
// The root is CANONICALIZED at resolution (Windows: `\\?\C:\…` verbatim
// form), which is what makes the containment checks below meaningful.
//
// Traversal guard — EVERY command that takes a relative path goes through it:
//   Layer 1 (validate_rel_path): component-wise inspection of the RAW input.
//     Rejects `..` (ParentDir), absolute paths (RootDir), drive/UNC/verbatim
//     prefixes (Prefix — covers `C:\…`, drive-relative `C:x`, `\\server\…`,
//     `\\?\…`), and `:` inside a component (Windows alternate-data-stream
//     names). This is a check on path COMPONENTS, not a string-prefix test on
//     uncanonicalized input, so `foo/../../bar` and separator-style games are
//     caught structurally.
//   Layer 2 (canonical containment): after joining onto the canonical root,
//     the existing part of the path (the file for reads, the parent dir for
//     writes) is canonicalized and must start_with the canonical root —
//     both sides are in the same `\\?\` canonical form, so this closes the
//     symlink/junction hole that component inspection cannot see.
//
// Commands are thin async wrappers over `*_at(root, …)` internals so the
// guard and list filtering are unit-testable without env/config mutation.

use std::fs;
use std::path::{Component, Path, PathBuf};

/// Default personal KB checkout. Personal single-machine app — this machine's
/// checkout path IS the sensible last-resort default (see module header).
const DEFAULT_KB_PATH: &str = "C:/Users/ericm/projects/personal-kb";

/// File extensions that count as KB documents. The KB holds markdown specs,
/// HTML wireframes, JSX/TSX wireframe sources, Mermaid diagrams, and the
/// project registry JSON.
const DOC_EXTENSIONS: &[&str] = &["md", "html", "htm", "jsx", "tsx", "mmd", "json"];

/// Resolve + canonicalize the KB root. Errors if the resolved directory does
/// not exist (canonicalize requires existence — that is the point: no command
/// operates relative to a phantom root).
pub(crate) fn resolve_kb_root() -> Result<PathBuf, String> {
    let raw = std::env::var("SWITCHBOARD_KB_PATH")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| crate::config::load_config().kb_path)
        .unwrap_or_else(|| DEFAULT_KB_PATH.to_string());
    fs::canonicalize(&raw).map_err(|e| format!("KB root {:?} unavailable: {}", raw, e))
}

/// Strip Windows verbatim prefixes for display (`\\?\C:\…` → `C:\…`,
/// `\\?\UNC\server\share` → `\\server\share`). Internal comparisons always
/// use the canonical form; only strings leaving the backend go through this.
fn display_path(p: &Path) -> String {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{}", rest)
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        s.into_owned()
    }
}

/// Guard layer 1: structural validation of a client-supplied relative path.
/// See module header for the full threat list this covers.
fn validate_rel_path(rel: &str) -> Result<(), String> {
    if rel.trim().is_empty() {
        return Err("empty path".to_string());
    }
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(seg) => {
                // `:` in a component is a Windows alternate-data-stream name
                // (`doc.md:hidden`) or a non-prefix drive form — no KB doc
                // legitimately contains one.
                if seg.to_string_lossy().contains(':') {
                    return Err(format!("invalid path component in {:?}", rel));
                }
            }
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(format!("path escapes KB root: {:?}", rel));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(format!("absolute path not allowed: {:?}", rel));
            }
        }
    }
    Ok(())
}

/// Guard layer 2: `candidate` must exist; its canonical form must sit under
/// the (already canonical) root. Returns the canonical path for use.
fn canonicalize_within(root: &Path, candidate: &Path) -> Result<PathBuf, String> {
    let canon = fs::canonicalize(candidate)
        .map_err(|e| format!("cannot resolve {:?}: {}", candidate, e))?;
    if canon.starts_with(root) {
        Ok(canon)
    } else {
        Err(format!("path escapes KB root: {:?}", candidate))
    }
}

fn skip_dir(name: &str) -> bool {
    name.starts_with('.') || name.starts_with('_') || name == "node_modules"
}

fn is_doc_file(name: &str) -> bool {
    // Dot-prefixed files are sidecars/hidden (`.pins.json` arrives in T7) —
    // never documents.
    if name.starts_with('.') {
        return false;
    }
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => {
            DOC_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str())
        }
        _ => false,
    }
}

/// Recursive listing core. Skips `.`/`_`-prefixed dirs and node_modules;
/// symlinked dirs are NOT followed (entry.file_type() reports the symlink
/// itself, which is neither dir nor doc-file — traversal stays physical).
fn collect_docs(root: &Path, dir: &Path, out: &mut Vec<String>) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("cannot list {:?}: {}", dir, e))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if file_type.is_dir() {
            if skip_dir(&name) {
                continue;
            }
            collect_docs(root, &entry.path(), out)?;
        } else if file_type.is_file() && is_doc_file(&name) {
            if let Ok(rel) = entry.path().strip_prefix(root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    Ok(())
}

// ── Testable internals ───────────────────────────────────────────────────────

fn list_docs_at(root: &Path) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    collect_docs(root, root, &mut out)?;
    out.sort();
    Ok(out)
}

fn read_doc_at(root: &Path, rel_path: &str) -> Result<String, String> {
    validate_rel_path(rel_path)?;
    let canon = canonicalize_within(root, &root.join(rel_path))?;
    fs::read_to_string(&canon).map_err(|e| format!("cannot read {:?}: {}", rel_path, e))
}

fn write_doc_at(root: &Path, rel_path: &str, content: &str) -> Result<(), String> {
    validate_rel_path(rel_path)?;
    let target = root.join(rel_path);
    let file_name = target
        .file_name()
        .ok_or_else(|| format!("invalid file path: {:?}", rel_path))?
        .to_owned();
    let parent = target
        .parent()
        .ok_or_else(|| format!("invalid file path: {:?}", rel_path))?;
    // Parent dirs are created as needed (pins sidecars land in nested feature
    // folders). Layer 1 already proved the joined path cannot step outside the
    // root, so create_dir_all cannot either; the canonical re-check afterwards
    // closes the pre-existing-symlink case.
    fs::create_dir_all(parent).map_err(|e| format!("cannot create dirs for {:?}: {}", rel_path, e))?;
    let canon_parent = canonicalize_within(root, parent)?;
    fs::write(canon_parent.join(file_name), content.as_bytes())
        .map_err(|e| format!("cannot write {:?}: {}", rel_path, e))
}

// ── Tauri commands ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn kb_root() -> Result<String, String> {
    Ok(display_path(&resolve_kb_root()?))
}

#[tauri::command]
pub async fn kb_list_docs() -> Result<Vec<String>, String> {
    let root = resolve_kb_root()?;
    list_docs_at(&root)
}

#[tauri::command]
pub async fn kb_read_doc(rel_path: String) -> Result<String, String> {
    let root = resolve_kb_root()?;
    read_doc_at(&root, &rel_path)
}

#[tauri::command]
pub async fn kb_write_doc(rel_path: String, content: String) -> Result<(), String> {
    log::info!("kb_write_doc {:?} ({} bytes)", rel_path, content.len());
    let root = resolve_kb_root()?;
    write_doc_at(&root, &rel_path, &content)
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod kb_tests {
    use super::*;

    /// Fresh canonical temp root per test (name-keyed; tests run in parallel).
    fn temp_root(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("switchboard-kb-test-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        fs::canonicalize(&p).unwrap()
    }

    fn write(root: &Path, rel: &str, content: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, content).unwrap();
    }

    // ── Guard layer 1: structural rejection of escape attempts ──

    #[test]
    fn guard_rejects_parent_dir_escapes() {
        for rel in [
            "../outside.md",
            "..",
            "a/../../b.md",
            r"..\outside.md",
            r"a\..\..\b.md",
            "switchboard/../../../etc/passwd",
        ] {
            assert!(validate_rel_path(rel).is_err(), "should reject {:?}", rel);
        }
    }

    #[test]
    fn guard_rejects_absolute_and_prefixed_paths() {
        for rel in [
            r"C:\Windows\evil.md",
            "C:/Windows/evil.md",
            "C:evil.md", // drive-relative
            "/etc/passwd",
            r"\abs\from\root.md",
            r"\\server\share\evil.md",
            r"\\?\C:\Users\evil.md",
            r"\\?\UNC\server\share\evil.md",
        ] {
            assert!(validate_rel_path(rel).is_err(), "should reject {:?}", rel);
        }
    }

    #[test]
    fn guard_rejects_empty_and_ads_components() {
        assert!(validate_rel_path("").is_err());
        assert!(validate_rel_path("   ").is_err());
        assert!(validate_rel_path("doc.md:stream").is_err());
        assert!(validate_rel_path("a/b:c/d.md").is_err());
    }

    #[test]
    fn guard_accepts_normal_relative_paths() {
        for rel in [
            "README.md",
            "switchboard/features/personal-workstation/requirements.md",
            "./a.md",
            r"a\b.md", // backslash separators are fine, still relative
        ] {
            assert!(validate_rel_path(rel).is_ok(), "should accept {:?}", rel);
        }
    }

    // ── Guard end-to-end on read/write ──

    #[test]
    fn read_inside_root_works_and_escape_is_rejected() {
        let root = temp_root("read");
        write(&root, "proj/doc.md", "# hello");
        assert_eq!(read_doc_at(&root, "proj/doc.md").unwrap(), "# hello");
        assert!(read_doc_at(&root, "../outside.md").is_err());
        assert!(read_doc_at(&root, r"C:\Windows\win.ini").is_err());
    }

    #[test]
    fn write_outside_root_rejected_and_nothing_created() {
        let root = temp_root("write-out");
        assert!(write_doc_at(&root, "../outside.md", "nope").is_err());
        assert!(!root.parent().unwrap().join("outside.md").exists());
        assert!(write_doc_at(&root, r"\\?\C:\outside.md", "nope").is_err());
    }

    #[test]
    fn write_inside_root_creates_parent_dirs() {
        let root = temp_root("write-in");
        write_doc_at(&root, "proj/nested/deep/pins.json", "[]").unwrap();
        assert_eq!(
            fs::read_to_string(root.join("proj/nested/deep/pins.json")).unwrap(),
            "[]"
        );
    }

    // ── List filtering ──

    #[test]
    fn list_filters_hidden_dirs_and_non_doc_files() {
        let root = temp_root("list");
        write(&root, "proj/doc.md", "d");
        write(&root, "proj/nested/wire.html", "w");
        write(&root, "proj/diagram.mmd", "m");
        write(&root, "proj/comp.tsx", "t");
        write(&root, "proj/comp.jsx", "j");
        write(&root, "registry.json", "{}");
        write(&root, "proj/notes.txt", "skip: not a doc extension");
        write(&root, "proj/noext", "skip: no extension");
        write(&root, "proj/.pins.json", "skip: dot-prefixed sidecar");
        write(&root, ".git/config.md", "skip: dot dir");
        write(&root, "_templates/tpl.md", "skip: underscore dir");
        write(&root, "node_modules/pkg/readme.md", "skip: node_modules");
        write(&root, "proj/_drafts/x.md", "skip: nested underscore dir");

        let docs = list_docs_at(&root).unwrap();
        assert_eq!(
            docs,
            vec![
                "proj/comp.jsx",
                "proj/comp.tsx",
                "proj/diagram.mmd",
                "proj/doc.md",
                "proj/nested/wire.html",
                "registry.json",
            ]
        );
        // Forward slashes only, no backslash leaks from Windows walk
        assert!(docs.iter().all(|d| !d.contains('\\')));
    }

    #[test]
    fn list_is_sorted_and_extension_check_is_case_insensitive() {
        let root = temp_root("list-sort");
        write(&root, "b/z.MD", "upper ext still a doc");
        write(&root, "a/a.md", "x");
        let docs = list_docs_at(&root).unwrap();
        assert_eq!(docs, vec!["a/a.md", "b/z.MD"]);
    }

    #[test]
    fn display_path_strips_verbatim_prefixes() {
        assert_eq!(display_path(Path::new(r"\\?\C:\kb")), r"C:\kb");
        assert_eq!(display_path(Path::new(r"\\?\UNC\srv\share")), r"\\srv\share");
        assert_eq!(display_path(Path::new(r"C:\kb")), r"C:\kb");
    }
}
