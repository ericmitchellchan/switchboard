// THE IPC ORIGIN GUARD — "an invoke that did not come from the app's own
// document does not run".
//
// WHY THIS FILE EXISTS (increment F measured it, increment G closed it):
// Tauri injects `__TAURI_INTERNALS__` into EVERY frame of a webview, subframes
// included. A production-build probe framing a plain `python -m http.server`
// established the table:
//
//     no sandbox                              -> invoke RESOLVED
//     sandbox="allow-scripts allow-same-origin" -> invoke RESOLVED
//     sandbox="allow-scripts"                 -> REJECTED ("Origin header is
//                                                not a valid URL")
//
// RESOLVED is literal: the framed page called `write_file` and a file appeared
// on disk, and `create_session` is process execution. The only thing standing
// between a framed page and full command access was the SANDBOX ATTRIBUTE at
// one call site (`LivePreview`/`LocalhostView` ships `allow-scripts
// allow-forms`), which means any future frame added anywhere with
// `allow-same-origin` silently re-opened the whole surface.
//
// WHERE THE HOLE ACTUALLY IS — read from tauri 2.10.2's source, not guessed:
//
//   · `tauri::webview::Webview::on_message` (webview/mod.rs) already computes
//     `Origin::Local` vs `Origin::Remote { url }` from the request's `Origin`
//     header and hands it to the ACL. A capability with no `remote` key
//     resolves ONLY to `ExecutionContext::Local`
//     (tauri-utils `acl::resolved::resolve_command`), and ours
//     (capabilities/default.json) has none — so every `plugin:` and `core:`
//     command was ALREADY denied to a framed origin.
//   · but the very next lines read:
//         // we only check ACL on plugin commands or if the app defined its ACL manifest
//         if (plugin_command.is_some() || has_app_acl_manifest) && … invoke.acl.is_none()
//     `has_app_acl_manifest` is FALSE for this app (build.rs calls
//     `tauri_build::try_build` with no `AppManifest`), so the app's OWN
//     commands — `write_file`, `create_session`, `kb_write_doc`, all of them —
//     skipped the origin check entirely and fell straight through to the
//     invoke handler. THAT is the whole hole, and it is exactly what the probe
//     measured.
//
// THE FIX: `Invoke::message` is public and `InvokeMessage::headers()` returns
// the request's `HeaderMap`, so the invoke handler in lib.rs wraps
// `generate_handler!` with `classify` below. An invoke whose `Origin` is not
// one of the app's own document origins is REJECTED and logged; nothing
// downstream ever sees it.
//
// THE SECOND TRANSPORT — and why an ABSENT Origin is allowed.
// Tauri has TWO IPC transports, and only one of them carries headers:
//   1. the CUSTOM PROTOCOL (`fetch` to `ipc://…`), which the browser stamps
//      with `Origin`. `tauri::ipc::protocol` REQUIRES it ("missing Origin
//      header"), so on this transport the header is always present.
//   2. the POSTMESSAGE fallback (`window.ipc.postMessage`), which
//      `scripts/ipc-protocol.js` switches to PERMANENTLY the first time the
//      fetch rejects — which is exactly what a page UNLOAD does to in-flight
//      requests. Switchboard's `beforeunload` flush (`save_scrollback`,
//      `save_threads`) lands here every reload, with `options.headers` empty
//      and therefore NO Origin. A "no header = deny" rule silently drops the
//      workspace save on every F5, which is data loss dressed as security.
// So an absent Origin means "transport 2", not "unknown caller" — PROVIDED a
// subframe cannot reach transport 2. On Windows/WebView2 it cannot, and that
// was MEASURED, not reasoned (probe, 2026-08-02, dev build, cross-origin frame
// with `allow-scripts allow-same-origin`):
//
//     __TAURI_INTERNALS__ present in the subframe            : true
//     window.ipc.postMessage present in the subframe          : true
//     [custom protocol] kb_root / write_file                  : REJECTED here
//     [postMessage, real invoke key, fetch forced to fail]    : NO RESPONSE,
//                                                               and no file
//     PARENT frame, same run                                  : RESOLVED
//
// The frame reached the transport and the transport went nowhere. That matches
// wry's wiring: `attach_ipc_handler` registers `ICoreWebView2::
// add_WebMessageReceived`, which WebView2 raises for the TOP-LEVEL DOCUMENT
// only — iframe posts raise `CoreWebView2Frame::WebMessageReceived`, which wry
// does not register. The positive control is in the app's own log: the
// beforeunload `save_scrollback` invokes DO arrive, with `origin "<none>"`.
// (Measured on Windows/WebView2, which is the platform this app ships on. If
// Switchboard ever ships a macOS/Linux build, re-run the probe there before
// trusting this branch.)
//
// Deliberately NOT done here:
//   · asking the webview for its URL per invoke — `Webview::url()` is a
//     blocking round trip to the UI thread, and `write_to_session` runs on
//     every keystroke. The allowlist is computed ONCE at setup from the app's
//     config, which is the same source Tauri's own `is_local_url` consults.
//   · declaring an app ACL manifest (build.rs `AppManifest`) to make Tauri do
//     this natively. It would work — it is the mechanism the `has_app_acl_manifest`
//     branch above is waiting for — but it also makes EVERY app command
//     ACL-gated by name, so a command missing from the capability list dies at
//     runtime. Same outcome, larger blast radius, and it would still need the
//     rejection LOG to be added by hand. Recorded here because it is the
//     framework-native alternative, not because it was overlooked.

use std::collections::BTreeSet;
use std::sync::OnceLock;

/// The app's own document origins. Populated once, in `run()`'s setup, before
/// the frontend can issue an invoke.
static APP_ORIGINS: OnceLock<BTreeSet<String>> = OnceLock::new();

/// Origins the app is served from in a PRODUCTION build, on every platform:
/// Windows/Android use `http(s)://tauri.localhost`, macOS/Linux use the
/// `tauri://localhost` custom scheme. A page CANNOT hold one of these unless it
/// IS the app's own bundle, so listing all three is not a widening — it just
/// means one binary works on any platform without re-deriving anything.
const BUILTIN_APP_ORIGINS: [&str; 3] = [
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
];

/// The ORIGIN of a URL — `scheme://host[:port]`, lower-cased, no path, no
/// trailing slash. Pure.
///
/// Deliberately string surgery rather than a URL parse: the value we compare
/// against is an `Origin` HEADER, which is already exactly this shape, and the
/// only other input is `devUrl` from the app's own config. Adding a `url`
/// dependency to normalize two strings would be the larger change.
///
/// Returns None for anything that is not `scheme://authority…` — including the
/// opaque-origin sentinel `null`, which is what a sandboxed frame WITHOUT
/// `allow-same-origin` sends. That is a rejection, and it must be.
pub fn origin_of(url: &str) -> Option<String> {
    let trimmed = url.trim();
    let scheme_end = trimmed.find("://")?;
    if scheme_end == 0 {
        return None;
    }
    let rest = &trimmed[scheme_end + 3..];
    // The authority runs to the first `/`, `?` or `#`.
    let authority_end = rest
        .find(|c| c == '/' || c == '?' || c == '#')
        .unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    if authority.is_empty() {
        return None;
    }
    // Credentials in an origin are never legitimate here, and `user@host` must
    // not be allowed to smuggle a different host past a naive compare.
    if authority.contains('@') {
        return None;
    }
    Some(format!(
        "{}://{}",
        trimmed[..scheme_end].to_ascii_lowercase(),
        authority.to_ascii_lowercase()
    ))
}

/// Build the allowlist. Pure, so the dev-vs-production rule is testable.
///
/// `dev_url` is the frontend dev server (`build.devUrl` in tauri.conf.json) and
/// is admitted ONLY in a dev run: the same config file ships inside the
/// production bundle, and admitting `http://localhost:1620` there would hand
/// IPC to whatever happened to be listening on that port.
pub fn build_allowlist(dev_url: Option<&str>, is_dev: bool) -> BTreeSet<String> {
    let mut set: BTreeSet<String> = BUILTIN_APP_ORIGINS.iter().map(|s| s.to_string()).collect();
    if is_dev {
        if let Some(origin) = dev_url.and_then(origin_of) {
            set.insert(origin);
        }
    }
    set
}

/// What an invoke's `Origin` header — or its absence — means.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// A custom-protocol invoke from one of the app's own document origins.
    App,
    /// NO `Origin` header at all — the `window.ipc.postMessage` transport,
    /// which is the TOP-LEVEL document's alone (see the module header's
    /// measurement). This is how a `beforeunload` flush arrives.
    PostMessage,
    /// Anything else: a framed page, an opaque origin (`null`), a malformed
    /// header. Refused.
    Deny,
}

/// THE rule, pure. Note the asymmetry between "no header" and "an unparseable
/// header": the first is a different TRANSPORT, the second is a caller that
/// HAS an origin and is not ours (`null` is exactly what a sandboxed frame
/// without `allow-same-origin` sends) — and is denied.
pub fn classify(origin: Option<&str>, allowed: &BTreeSet<String>) -> Verdict {
    let Some(raw) = origin else {
        return Verdict::PostMessage;
    };
    match origin_of(raw) {
        Some(o) if allowed.contains(&o) => Verdict::App,
        _ => Verdict::Deny,
    }
}

/// Convenience predicate over `classify`: does this invoke run?
pub fn origin_allowed(origin: Option<&str>, allowed: &BTreeSet<String>) -> bool {
    classify(origin, allowed) != Verdict::Deny
}

/// Install the allowlist. Called once from `run()`'s setup; later calls are
/// ignored (OnceLock), which is the correct behaviour for a security decision
/// that must not be re-openable at runtime.
pub fn install_app_origins(dev_url: Option<&str>, is_dev: bool) {
    let allowed = build_allowlist(dev_url, is_dev);
    log::info!("IPC origin allowlist: {:?}", allowed);
    let _ = APP_ORIGINS.set(allowed);
}

/// THE gate. `true` = let the invoke through.
///
/// An invoke arriving before `install_app_origins` has run is REFUSED: the
/// setup hook runs before the frontend loads, so this cannot happen through the
/// normal order, but "we do not know yet" must never mean "yes".
pub fn is_app_origin(origin: Option<&str>) -> bool {
    match APP_ORIGINS.get() {
        Some(allowed) => origin_allowed(origin, allowed),
        None => false,
    }
}

/// The rejection message handed back to the calling frame. Deliberately terse —
/// the detail goes to the LOG, not to a page we do not trust.
pub const REJECTION: &str = "IPC denied: this command is only available to the Switchboard window";

#[cfg(test)]
mod ipc_guard_tests {
    use super::*;

    fn allowed() -> BTreeSet<String> {
        build_allowlist(Some("http://localhost:1620"), true)
    }

    #[test]
    fn origin_of_strips_path_query_and_fragment() {
        assert_eq!(
            origin_of("http://tauri.localhost/index.html?screen=kb#x").as_deref(),
            Some("http://tauri.localhost")
        );
        assert_eq!(
            origin_of("http://localhost:1620/pip.html").as_deref(),
            Some("http://localhost:1620")
        );
        assert_eq!(
            origin_of("tauri://localhost").as_deref(),
            Some("tauri://localhost")
        );
    }

    #[test]
    fn origin_of_lowercases_scheme_and_host_but_keeps_port() {
        assert_eq!(
            origin_of("HTTP://Tauri.LocalHost/x").as_deref(),
            Some("http://tauri.localhost")
        );
        assert_eq!(
            origin_of("http://LOCALHOST:5173").as_deref(),
            Some("http://localhost:5173")
        );
    }

    #[test]
    fn origin_of_rejects_opaque_and_malformed() {
        // `null` is what a sandboxed frame with no `allow-same-origin` sends —
        // the case tauri already refused, kept refused here.
        assert_eq!(origin_of("null"), None);
        assert_eq!(origin_of(""), None);
        assert_eq!(origin_of("://host"), None);
        assert_eq!(origin_of("http:///path"), None);
        // Credentials must not smuggle a different host past the compare.
        assert_eq!(origin_of("http://tauri.localhost@evil.example/"), None);
    }

    #[test]
    fn app_window_origins_are_allowed() {
        let a = allowed();
        assert!(origin_allowed(Some("http://tauri.localhost"), &a));
        assert!(origin_allowed(Some("tauri://localhost"), &a));
        // The PiP window is the SAME origin — one allowlist covers both.
        assert!(origin_allowed(Some("http://tauri.localhost/pip.html"), &a));
        // Dev run: the vite dev server the app itself is served from.
        assert!(origin_allowed(Some("http://localhost:1620"), &a));
    }

    #[test]
    fn a_framed_dev_server_is_denied_however_it_is_sandboxed() {
        let a = allowed();
        // `allow-scripts allow-same-origin` on a localhost preview — the case
        // increment F measured as RESOLVING an unguarded `write_file`, and
        // increment G's probe measured as REJECTED here.
        assert_eq!(classify(Some("http://localhost:5173"), &a), Verdict::Deny);
        assert_eq!(classify(Some("http://127.0.0.1:1699"), &a), Verdict::Deny);
        assert_eq!(classify(Some("http://127.0.0.1:1620"), &a), Verdict::Deny);
        // `allow-scripts` alone: opaque origin. Tauri's protocol layer already
        // refuses this one ("Origin header is not a valid URL"); denying it
        // here too costs nothing and does not depend on that staying true.
        assert_eq!(classify(Some("null"), &a), Verdict::Deny);
        assert_eq!(classify(Some(""), &a), Verdict::Deny);
    }

    /// THE SECOND TRANSPORT. An ABSENT Origin is the `window.ipc.postMessage`
    /// fallback, which `scripts/ipc-protocol.js` switches to permanently when a
    /// custom-protocol fetch rejects — which is what a page UNLOAD does to
    /// in-flight requests. Switchboard's `beforeunload` flush (save_scrollback,
    /// save_threads) arrives exactly this way; denying it would drop the
    /// workspace save on every reload. Measured unreachable from a subframe on
    /// Windows/WebView2 — see the module header.
    #[test]
    fn an_absent_origin_is_the_postmessage_transport_not_an_unknown_caller() {
        let a = allowed();
        assert_eq!(classify(None, &a), Verdict::PostMessage);
        assert!(origin_allowed(None, &a));
        // …and it is NOT the same as an origin we cannot parse.
        assert_eq!(classify(Some("null"), &a), Verdict::Deny);
        assert!(!origin_allowed(Some("null"), &a));
    }

    #[test]
    fn classify_names_the_app_transport_too() {
        let a = allowed();
        assert_eq!(classify(Some("http://tauri.localhost"), &a), Verdict::App);
        assert_eq!(classify(Some("http://localhost:1620/index.html"), &a), Verdict::App);
    }

    #[test]
    fn near_miss_hosts_are_denied() {
        let a = allowed();
        assert!(!origin_allowed(Some("http://tauri.localhost.evil.example"), &a));
        assert!(!origin_allowed(Some("http://eviltauri.localhost"), &a));
        // Port matters: the allowlisted dev origin is 1620, not 16200.
        assert!(!origin_allowed(Some("http://localhost:16200"), &a));
    }

    #[test]
    fn dev_url_is_not_admitted_in_a_production_run() {
        let prod = build_allowlist(Some("http://localhost:1620"), false);
        assert!(!origin_allowed(Some("http://localhost:1620"), &prod));
        // …while the bundle's own origin still works.
        assert!(origin_allowed(Some("http://tauri.localhost"), &prod));
    }

    #[test]
    fn an_empty_allowlist_denies_every_origin() {
        let empty = BTreeSet::new();
        assert_eq!(classify(Some("http://tauri.localhost"), &empty), Verdict::Deny);
        assert_eq!(classify(Some("http://localhost:1620"), &empty), Verdict::Deny);
    }
}
