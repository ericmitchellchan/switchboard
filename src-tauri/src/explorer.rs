// Explorer backend (T9) — registry-driven repo browsing.
//
// The set of browsable roots is NOT client-supplied: it is built from
// `<kb_root>/registry.json` (kb.rs::resolve_kb_root — the registry lives at
// the KB root). `conventions.reposRoot` + each project's `repos[]` (and each
// `archived` entry's `path`) resolve to absolute repo paths; every command
// addresses a repo by PROJECT KEY + relative path, so the frontend can never
// name an arbitrary directory.
//
// Registry parsing is LENIENT by contract (the file is hand-edited):
//   - unknown fields anywhere are ignored,
//   - a missing/invalid `status` defaults to "active",
//   - non-string entries inside `repos` are skipped,
//   - a malformed project entry is skipped rather than failing the parse,
//   - `archived` entries become projects with status "archived".
// Only two things are fatal: unparseable JSON and a missing/empty
// `conventions.reposRoot` (without it no path can be resolved).
//
// Traversal guard — identical IN SPIRIT to kb.rs (see its module header for
// the threat model): layer 1 is component-wise validation of the raw relative
// path (rejects `..`, absolute/drive/verbatim/UNC forms, `:` in components);
// layer 2 canonicalizes the joined path and requires containment inside that
// project's canonical repo root, which closes the symlink/junction hole.
// kb.rs's guard functions are private to their threat surface; the ~30 lines
// are mirrored here rather than widening kb.rs's API beyond resolve_kb_root.
//
// Multi-repo projects (e.g. chat-recall with 4 repos) get a VIRTUAL root: at
// rel "" the listing is the repo names; the first path component selects the
// repo. Single-repo projects collapse — rel paths start inside the repo, so
// the breadcrumb reads `lodestar / packages / …` like the approved wireframe.

use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};

/// Files larger than this are refused by explorer_read — the inline viewer is
/// for sources/docs, not blobs, and a multi-MB string melts the webview.
const MAX_READ_BYTES: u64 = 512 * 1024;

/// Directory names never listed (VCS + dependency/build output).
const SKIP_DIRS: &[&str] = &[".git", "node_modules", ".venv", "venv", "target", "__pycache__", "dist"];

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct ProjectInfo {
    pub key: String,
    pub status: String,
    /// Absolute repo paths (forward slashes) — the frontend matches live
    /// thread workingDirs against these.
    pub repos: Vec<String>,
    /// Registry `notes` free text, when present.
    pub note: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Entry {
    pub name: String,
    pub is_dir: bool,
}

// ── Registry parsing (pure — fixture-testable) ───────────────────────────────

fn parse_registry(json: &str) -> Result<Vec<ProjectInfo>, String> {
    let root: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("registry.json unparseable: {}", e))?;
    let repos_root = root
        .pointer("/conventions/reposRoot")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "registry.json missing conventions.reposRoot".to_string())?
        .trim_end_matches(['/', '\\'])
        .to_string();

    let mut out = Vec::new();

    if let Some(projects) = root.get("projects").and_then(|v| v.as_object()) {
        for (key, entry) in projects {
            let Some(entry) = entry.as_object() else { continue };
            let status = entry
                .get("status")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("active")
                .to_string();
            let repos: Vec<String> = entry
                .get("repos")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str())
                        .filter(|s| !s.trim().is_empty())
                        .map(|name| format!("{}/{}", repos_root, name))
                        .collect()
                })
                .unwrap_or_default();
            let note = entry
                .get("notes")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            out.push(ProjectInfo { key: key.clone(), status, repos, note });
        }
    }

    if let Some(archived) = root.get("archived").and_then(|v| v.as_object()) {
        for (key, entry) in archived {
            let Some(entry) = entry.as_object() else { continue };
            let Some(path) = entry
                .get("path")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
            else {
                continue;
            };
            let note = entry
                .get("reason")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            out.push(ProjectInfo {
                key: key.clone(),
                status: "archived".to_string(),
                repos: vec![format!("{}/{}", repos_root, path)],
                note,
            });
        }
    }

    Ok(out)
}

fn load_registry() -> Result<Vec<ProjectInfo>, String> {
    let kb_root = crate::kb::resolve_kb_root()?;
    let path = kb_root.join("registry.json");
    let text =
        fs::read_to_string(&path).map_err(|e| format!("cannot read registry.json: {}", e))?;
    parse_registry(&text)
}

// ── Traversal guard (mirrors kb.rs layers 1+2 — see module header) ───────────

fn validate_rel_path(rel: &str) -> Result<(), String> {
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(seg) => {
                // `:` in a component = Windows alternate-data-stream name or a
                // non-prefix drive form — never a legitimate repo path.
                if seg.to_string_lossy().contains(':') {
                    return Err(format!("invalid path component in {:?}", rel));
                }
            }
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(format!("path escapes repo root: {:?}", rel));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(format!("absolute path not allowed: {:?}", rel));
            }
        }
    }
    Ok(())
}

fn canonicalize_within(root: &Path, candidate: &Path) -> Result<PathBuf, String> {
    let canon = fs::canonicalize(candidate)
        .map_err(|e| format!("cannot resolve {:?}: {}", candidate, e))?;
    if canon.starts_with(root) {
        Ok(canon)
    } else {
        Err(format!("path escapes repo root: {:?}", candidate))
    }
}

// ── Repo resolution ──────────────────────────────────────────────────────────

/// Last path segment of a registry repo path (the repo's display name — also
/// the first rel component for multi-repo projects).
fn repo_name(repo_path: &str) -> &str {
    repo_path
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(repo_path)
}

fn find_project(projects: &[ProjectInfo], key: &str) -> Result<ProjectInfo, String> {
    projects
        .iter()
        .find(|p| p.key == key)
        .cloned()
        .ok_or_else(|| format!("unknown project {:?}", key))
}

/// Resolve (project, rel) → (canonical repo root, remaining rel path).
/// Single-repo projects collapse (rel starts inside the repo); multi-repo
/// projects consume the first rel component as the repo name — a rel of ""
/// there has no single root and is handled by the caller (virtual listing).
fn resolve_repo_rel(project: &ProjectInfo, rel: &str) -> Result<(PathBuf, String), String> {
    validate_rel_path(rel)?;
    let rel_norm = rel.trim_matches(['/', '\\']).to_string();
    let (repo_path, rest) = match project.repos.len() {
        0 => return Err(format!("project {:?} has no repos", project.key)),
        1 => (project.repos[0].clone(), rel_norm),
        _ => {
            let (first, rest) = match rel_norm.split_once(['/', '\\']) {
                Some((a, b)) => (a, b.to_string()),
                None => (rel_norm.as_str(), String::new()),
            };
            let repo = project
                .repos
                .iter()
                .find(|r| repo_name(r) == first)
                .ok_or_else(|| format!("unknown repo {:?} in project {:?}", first, project.key))?;
            (repo.clone(), rest)
        }
    };
    let root = fs::canonicalize(&repo_path)
        .map_err(|e| format!("repo root {:?} unavailable: {}", repo_path, e))?;
    Ok((root, rest))
}

// ── Testable internals ───────────────────────────────────────────────────────

fn list_entries(dir: &Path) -> Result<Vec<Entry>, String> {
    let read = fs::read_dir(dir).map_err(|e| format!("cannot list {:?}: {}", dir, e))?;
    let mut out = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        // Symlinks are neither dir nor file here — traversal stays physical
        // (same posture as kb.rs collect_docs).
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if file_type.is_dir() {
            if SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            out.push(Entry { name, is_dir: true });
        } else if file_type.is_file() {
            out.push(Entry { name, is_dir: false });
        }
    }
    // Dirs first, then case-insensitive alphabetical — the wireframe's order.
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

fn list_at(project: &ProjectInfo, rel_dir: &str) -> Result<Vec<Entry>, String> {
    validate_rel_path(rel_dir)?;
    let rel_norm = rel_dir.trim_matches(['/', '\\']);
    // Multi-repo virtual root: the repos themselves are the listing.
    if project.repos.len() > 1 && rel_norm.is_empty() {
        let mut out: Vec<Entry> = project
            .repos
            .iter()
            .map(|r| Entry { name: repo_name(r).to_string(), is_dir: true })
            .collect();
        out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        return Ok(out);
    }
    let (root, rest) = resolve_repo_rel(project, rel_norm)?;
    let dir = if rest.is_empty() { root.clone() } else { root.join(&rest) };
    let canon = canonicalize_within(&root, &dir)?;
    list_entries(&canon)
}

fn read_at(project: &ProjectInfo, rel_path: &str) -> Result<String, String> {
    let (root, rest) = resolve_repo_rel(project, rel_path)?;
    if rest.is_empty() {
        return Err("not a file".to_string());
    }
    let canon = canonicalize_within(&root, &root.join(&rest))?;
    let meta = fs::metadata(&canon).map_err(|e| format!("cannot stat {:?}: {}", rel_path, e))?;
    if meta.len() > MAX_READ_BYTES {
        return Err(format!(
            "file too large for the inline viewer ({} KB > {} KB limit)",
            meta.len() / 1024,
            MAX_READ_BYTES / 1024
        ));
    }
    fs::read_to_string(&canon).map_err(|e| format!("cannot read {:?}: {}", rel_path, e))
}

/// Write `content` to a file that ALREADY EXISTS inside the project's repo
/// root (increment G — repo markdown is editable, not only KB docs).
///
/// The guard is the SAME two layers `read_at` goes through, in the same order,
/// because the containment argument is the same one:
///   1. `resolve_repo_rel` runs layer 1 (`validate_rel_path`: no `..`, no
///      absolute/drive/verbatim/UNC form, no `:` in a component) and resolves
///      the CANONICAL repo root;
///   2. `canonicalize_within` resolves the target and requires it to sit under
///      that root — which is what closes the symlinked/junctioned-parent hole
///      that layer 1 alone cannot see.
///
/// Then two rules layer 2 does not cover, both borrowed from `kb::write_doc_at`:
///   · the file must ALREADY EXIST. kb_write_doc creates (pins sidecars land in
///     new folders); this command edits documents you opened, so a create path
///     would be a way to drop new files into a source tree with no UI for it.
///     `fs::canonicalize` requires existence anyway, which is what makes layer 2
///     apply to the FINAL component here and not merely to its parent — the
///     precise reason kb.rs needs an extra `symlink_metadata` check and this
///     does not.
///   · a symlink at the target is refused outright, so an existing symlink
///     inside the repo cannot redirect the write outside it. (Canonicalize
///     would already have resolved it and containment would already have
///     judged the RESOLVED path — this refuses even a symlink that resolves to
///     a legal in-repo path, because writing "through" a link is never what an
///     editor buffer means.)
fn write_at(project: &ProjectInfo, rel_path: &str, content: &str) -> Result<(), String> {
    let (root, rest) = resolve_repo_rel(project, rel_path)?;
    if rest.is_empty() {
        return Err("not a file".to_string());
    }
    let target = root.join(&rest);
    if let Ok(meta) = fs::symlink_metadata(&target) {
        // is_symlink() covers Windows symlink files/dirs AND junction reparse
        // points.
        if meta.file_type().is_symlink() {
            return Err(format!("refusing to write through symlink {:?}", rel_path));
        }
    }
    let canon = canonicalize_within(&root, &target)?;
    let meta = fs::metadata(&canon).map_err(|e| format!("cannot stat {:?}: {}", rel_path, e))?;
    if !meta.is_file() {
        return Err(format!("not a file: {:?}", rel_path));
    }
    fs::write(&canon, content.as_bytes()).map_err(|e| format!("cannot write {:?}: {}", rel_path, e))
}

// ── Tauri commands ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn explorer_projects() -> Result<Vec<ProjectInfo>, String> {
    load_registry()
}

#[tauri::command]
pub async fn explorer_list(project_key: String, rel_dir: String) -> Result<Vec<Entry>, String> {
    let projects = load_registry()?;
    let project = find_project(&projects, &project_key)?;
    list_at(&project, &rel_dir)
}

#[tauri::command]
pub async fn explorer_read(project_key: String, rel_path: String) -> Result<String, String> {
    let projects = load_registry()?;
    let project = find_project(&projects, &project_key)?;
    read_at(&project, &rel_path)
}

#[tauri::command]
pub async fn explorer_write(
    project_key: String,
    rel_path: String,
    content: String,
) -> Result<(), String> {
    log::info!(
        "explorer_write {}/{:?} ({} bytes)",
        project_key,
        rel_path,
        content.len()
    );
    let projects = load_registry()?;
    let project = find_project(&projects, &project_key)?;
    write_at(&project, &rel_path, &content)
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod explorer_tests {
    use super::*;

    const FIXTURE: &str = r#"{
      "$comment": "trimmed copy of the real registry shape",
      "conventions": {
        "reposRoot": "C:/Users/ericm/projects",
        "github": "ericmitchellchan",
        "unknownConvention": true
      },
      "projects": {
        "switchboard": {
          "repos": ["switchboard"],
          "status": "active",
          "kbFolder": "switchboard",
          "notes": "Becoming the personal workstation."
        },
        "chat-recall": {
          "repos": ["chat-recall-mcp", "chat-recall-api", "chat-recall-prod", "chat-recall-web"],
          "status": "paused"
        },
        "no-status": {
          "repos": ["nightshift"],
          "someUnknownField": {"nested": 1}
        },
        "broken-entry": "not an object",
        "weird-repos": {
          "repos": ["ok-repo", 42, null, ""]
        }
      },
      "archived": {
        "nba-jarvis": {
          "path": "_archive/nba-jarvis",
          "reason": "absorbed into lodestar (LODE-17)",
          "archived": "2026-07-31"
        },
        "broken-archived": {"reason": "no path"}
      }
    }"#;

    fn fixture_project(key: &str) -> ProjectInfo {
        let projects = parse_registry(FIXTURE).unwrap();
        projects.into_iter().find(|p| p.key == key).unwrap()
    }

    // ── Registry parse leniency ──

    #[test]
    fn parse_reads_projects_with_absolute_repo_paths() {
        let p = fixture_project("switchboard");
        assert_eq!(p.status, "active");
        assert_eq!(p.repos, vec!["C:/Users/ericm/projects/switchboard"]);
        assert_eq!(p.note.as_deref(), Some("Becoming the personal workstation."));
    }

    #[test]
    fn parse_defaults_missing_status_to_active_and_ignores_unknown_fields() {
        let p = fixture_project("no-status");
        assert_eq!(p.status, "active");
        assert_eq!(p.repos, vec!["C:/Users/ericm/projects/nightshift"]);
        assert_eq!(p.note, None);
    }

    #[test]
    fn parse_skips_malformed_entries_and_non_string_repos() {
        let projects = parse_registry(FIXTURE).unwrap();
        assert!(projects.iter().all(|p| p.key != "broken-entry"));
        assert!(projects.iter().all(|p| p.key != "broken-archived"));
        let weird = fixture_project("weird-repos");
        assert_eq!(weird.repos, vec!["C:/Users/ericm/projects/ok-repo"]);
    }

    #[test]
    fn parse_includes_archived_entries_with_archived_status() {
        let p = fixture_project("nba-jarvis");
        assert_eq!(p.status, "archived");
        assert_eq!(p.repos, vec!["C:/Users/ericm/projects/_archive/nba-jarvis"]);
        assert_eq!(p.note.as_deref(), Some("absorbed into lodestar (LODE-17)"));
    }

    #[test]
    fn parse_preserves_registry_file_order() {
        // serde_json's `preserve_order` feature (Cargo.toml) keeps JSON maps
        // in file order — the Explorer rail lists projects as the registry
        // orders them, active projects before the archived section.
        let projects = parse_registry(FIXTURE).unwrap();
        let keys: Vec<&str> = projects.iter().map(|p| p.key.as_str()).collect();
        assert_eq!(
            keys,
            vec!["switchboard", "chat-recall", "no-status", "weird-repos", "nba-jarvis"]
        );
    }

    #[test]
    fn parse_multi_repo_project_keeps_all_repos() {
        let p = fixture_project("chat-recall");
        assert_eq!(p.status, "paused");
        assert_eq!(p.repos.len(), 4);
        assert!(p.repos.iter().all(|r| r.starts_with("C:/Users/ericm/projects/chat-recall-")));
    }

    #[test]
    fn parse_fails_on_bad_json_and_missing_repos_root() {
        assert!(parse_registry("not json").is_err());
        assert!(parse_registry(r#"{"projects": {}}"#).is_err());
        assert!(parse_registry(r#"{"conventions": {"reposRoot": "  "}, "projects": {}}"#).is_err());
    }

    // ── Guard ──

    #[test]
    fn guard_rejects_escapes_and_absolute_paths() {
        for rel in [
            "../outside.txt",
            "..",
            "a/../../b.txt",
            r"..\outside.txt",
            r"C:\Windows\evil.txt",
            "C:/Windows/evil.txt",
            "C:evil.txt",
            "/etc/passwd",
            r"\abs\from\root.txt",
            r"\\server\share\evil.txt",
            r"\\?\C:\Users\evil.txt",
            "file.txt:stream",
        ] {
            assert!(validate_rel_path(rel).is_err(), "should reject {:?}", rel);
        }
    }

    #[test]
    fn guard_accepts_normal_relative_paths() {
        for rel in ["", "src", "src/lib/kb.ts", "./a.txt", r"a\b.txt"] {
            assert!(validate_rel_path(rel).is_ok(), "should accept {:?}", rel);
        }
    }

    // ── list / read end-to-end on a temp repo ──

    fn temp_repo(tag: &str) -> PathBuf {
        let p = std::env::temp_dir()
            .join(format!("switchboard-explorer-test-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        fs::canonicalize(&p).unwrap()
    }

    fn write(root: &Path, rel: &str, content: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, content).unwrap();
    }

    fn project_for(root: &Path) -> ProjectInfo {
        ProjectInfo {
            key: "test".to_string(),
            status: "active".to_string(),
            repos: vec![root.to_string_lossy().into_owned()],
            note: None,
        }
    }

    #[test]
    fn list_filters_skip_dirs_and_sorts_dirs_first() {
        let root = temp_repo("list");
        write(&root, "src/lib.rs", "x");
        write(&root, "README.md", "x");
        write(&root, "zeta.txt", "x");
        write(&root, ".git/config", "skip");
        write(&root, "node_modules/pkg/index.js", "skip");
        write(&root, "target/debug/bin", "skip");
        write(&root, "__pycache__/m.pyc", "skip");
        write(&root, "dist/out.js", "skip");
        write(&root, ".venv/pyvenv.cfg", "skip");
        write(&root, "venv/pyvenv.cfg", "skip");

        let entries = list_at(&project_for(&root), "").unwrap();
        let names: Vec<(String, bool)> =
            entries.into_iter().map(|e| (e.name, e.is_dir)).collect();
        assert_eq!(
            names,
            vec![
                ("src".to_string(), true),
                ("README.md".to_string(), false),
                ("zeta.txt".to_string(), false),
            ]
        );
    }

    #[test]
    fn list_descends_and_rejects_escapes() {
        let root = temp_repo("descend");
        write(&root, "src/lib/mod.rs", "x");
        let entries = list_at(&project_for(&root), "src/lib").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "mod.rs");
        assert!(!entries[0].is_dir);

        assert!(list_at(&project_for(&root), "../").is_err());
        assert!(list_at(&project_for(&root), "src/../../").is_err());
        assert!(list_at(&project_for(&root), r"C:\Windows").is_err());
    }

    #[test]
    fn multi_repo_virtual_root_lists_repo_names_then_descends() {
        let root_a = temp_repo("multi-a");
        let root_b = temp_repo("multi-b");
        write(&root_a, "a.txt", "x");
        write(&root_b, "b.txt", "x");
        let project = ProjectInfo {
            key: "multi".to_string(),
            status: "active".to_string(),
            repos: vec![
                root_b.to_string_lossy().into_owned(),
                root_a.to_string_lossy().into_owned(),
            ],
            note: None,
        };
        let virtual_root = list_at(&project, "").unwrap();
        assert_eq!(virtual_root.len(), 2);
        assert!(virtual_root.iter().all(|e| e.is_dir));
        // sorted alphabetically regardless of registry order
        assert!(virtual_root[0].name < virtual_root[1].name);

        let a_name = root_a.file_name().unwrap().to_string_lossy().into_owned();
        let inside = list_at(&project, &a_name).unwrap();
        assert_eq!(inside.len(), 1);
        assert_eq!(inside[0].name, "a.txt");
        assert!(list_at(&project, "not-a-repo/src").is_err());
    }

    #[test]
    fn read_works_inside_and_rejects_escape_and_oversize() {
        let root = temp_repo("read");
        write(&root, "src/main.rs", "fn main() {}");
        let project = project_for(&root);
        assert_eq!(read_at(&project, "src/main.rs").unwrap(), "fn main() {}");
        assert!(read_at(&project, "../outside.txt").is_err());
        assert!(read_at(&project, "").is_err());

        let big = "x".repeat((MAX_READ_BYTES + 1) as usize);
        write(&root, "big.txt", &big);
        let err = read_at(&project, "big.txt").unwrap_err();
        assert!(err.contains("too large"), "unexpected error: {}", err);
    }

    // ── Write guard (increment G) ──
    // Mirrors kb.rs's write guard tests: the same two layers, plus the
    // must-already-exist rule that is this command's own.

    #[test]
    fn write_replaces_an_existing_file_in_place() {
        let root = temp_repo("write-ok");
        write(&root, "specs/plan.md", "# before");
        let project = project_for(&root);
        write_at(&project, "specs/plan.md", "# after").unwrap();
        assert_eq!(read_at(&project, "specs/plan.md").unwrap(), "# after");
    }

    #[test]
    fn write_outside_repo_root_is_rejected_and_nothing_created() {
        let root = temp_repo("write-escape");
        write(&root, "keep.md", "x");
        let project = project_for(&root);

        for rel in [
            "../outside.md",
            "specs/../../outside.md",
            "C:/Windows/Temp/outside.md",
            "/etc/passwd",
            r"\\server\share\outside.md",
            "doc.md:hidden",
        ] {
            let err = write_at(&project, rel, "escape").unwrap_err();
            assert!(!err.is_empty(), "expected a rejection for {:?}", rel);
        }

        // The sibling of the repo root is where `..` would have landed.
        let outside = root.parent().unwrap().join("outside.md");
        assert!(!outside.exists(), "a write escaped to {:?}", outside);
        // …and the legitimate file is untouched.
        assert_eq!(read_at(&project, "keep.md").unwrap(), "x");
    }

    #[test]
    fn write_refuses_to_create_and_refuses_a_directory() {
        let root = temp_repo("write-create");
        let project = project_for(&root);
        // A file that does not exist: canonicalize fails, so containment is
        // never even in question — this command edits, it does not create.
        assert!(write_at(&project, "brand-new.md", "nope").is_err());
        assert!(!root.join("brand-new.md").exists());
        // An empty rel path is the repo root itself.
        assert!(write_at(&project, "", "nope").is_err());
        // A directory target.
        write(&root, "src/lib.rs", "x");
        assert!(write_at(&project, "src", "nope").is_err());
    }

    /// The unknown-project gate: `explorer_write` addresses a repo by registry
    /// KEY, so a path can only ever be resolved against a root the registry
    /// named. There is no client-supplied root to escape from.
    #[test]
    fn write_to_an_unknown_project_is_rejected() {
        let projects = parse_registry(FIXTURE).unwrap();
        assert!(find_project(&projects, "not-a-project").is_err());
    }

    /// Junction (dir reparse point) escape through the PARENT — the case layer
    /// 1 cannot see and `canonicalize_within` exists for. Junctions need no
    /// privilege, so this runs on any Windows box.
    #[cfg(windows)]
    #[test]
    fn write_rejects_junctioned_parent_dir_escape() {
        let root = temp_repo("write-junction");
        let outside_dir = temp_repo("write-junction-outside");
        fs::write(outside_dir.join("evil.md"), "original").unwrap();
        let junction = root.join("jdir");
        if !make_junction(&junction, &outside_dir) {
            eprintln!("junction creation failed — skipping");
            return;
        }
        let project = project_for(&root);
        let err = write_at(&project, "jdir/evil.md", "escape").unwrap_err();
        assert!(err.contains("escapes repo root"), "unexpected error: {}", err);
        assert_eq!(
            fs::read_to_string(outside_dir.join("evil.md")).unwrap(),
            "original"
        );
    }

    /// A symlink FILE at the target is refused before the write, so an existing
    /// link inside the repo cannot redirect an editor buffer out of it.
    /// Degrades (like kb.rs's twin) to asserting the reparse-DETECTION
    /// predicate when the runner lacks symlink privilege.
    #[test]
    fn write_rejects_pre_existing_symlink_file_target() {
        let root = temp_repo("write-symlink");
        let outside = std::env::temp_dir()
            .join(format!("switchboard-explorer-outside-{}.md", std::process::id()));
        fs::write(&outside, "outside-original").unwrap();
        let link = root.join("link.md");

        #[cfg(windows)]
        let link_created = std::os::windows::fs::symlink_file(&outside, &link).is_ok();
        #[cfg(unix)]
        let link_created = std::os::unix::fs::symlink(&outside, &link).is_ok();

        let project = project_for(&root);
        if link_created {
            let err = write_at(&project, "link.md", "redirected!").unwrap_err();
            assert!(err.contains("symlink"), "unexpected error: {}", err);
            assert_eq!(fs::read_to_string(&outside).unwrap(), "outside-original");
        } else {
            eprintln!(
                "symlink_file unavailable (no dev-mode privilege) — asserting \
                 reparse detection via junction instead"
            );
            let target_dir = temp_repo("write-symlink-jtarget");
            let junction = root.join("jdir");
            if !make_junction(&junction, &target_dir) {
                eprintln!("junction creation failed too — skipping");
                return;
            }
            assert!(fs::symlink_metadata(&junction).unwrap().file_type().is_symlink());
        }
        let _ = fs::remove_file(&outside);
    }

    /// Create an NTFS junction (no privilege required). Returns false if the
    /// tool or filesystem refuses.
    #[cfg(windows)]
    fn make_junction(link: &Path, target: &Path) -> bool {
        // cmd's mklink rejects `\\?\` verbatim forms — strip for the shell.
        let strip = |p: &Path| {
            let s = p.to_string_lossy().into_owned();
            s.strip_prefix(r"\\?\").map(|s| s.to_string()).unwrap_or(s)
        };
        std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J", &strip(link), &strip(target)])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    #[cfg(not(windows))]
    fn make_junction(_link: &Path, _target: &Path) -> bool {
        false
    }
}
