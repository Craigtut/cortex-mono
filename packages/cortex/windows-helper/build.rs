//! Build script: embed the application manifest into the helper exe.
//!
//! The manifest pins `requestedExecutionLevel=asInvoker` (unelevated),
//! long-path awareness, and the UTF-8 active code page. Embedding it via the
//! linker `/MANIFESTINPUT` keeps a single source of truth (app.manifest) rather
//! than a separate .rc file. This runs only when targeting Windows MSVC; on any
//! other host it is a no-op so the crate metadata still parses.

fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os != "windows" || target_env != "msvc" {
        // Not a Windows MSVC build (e.g. a metadata check on macOS/Linux). Nothing to embed.
        return;
    }

    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("app.manifest");
    println!("cargo:rerun-if-changed=app.manifest");
    // MSVC linker: merge our manifest into the final image.
    println!(
        "cargo:rustc-link-arg-bins=/MANIFESTINPUT:{}",
        manifest.display()
    );
    println!("cargo:rustc-link-arg-bins=/MANIFEST:EMBED");
}
