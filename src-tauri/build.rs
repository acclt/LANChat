#[cfg(feature = "desktop")]
fn main() {
    // Android must serve packaged assets in release mode, never proxy a dev server.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android")
        && std::env::var("PROFILE").as_deref() == Ok("release")
        && std::env::var("DEP_TAURI_DEV").as_deref() != Ok("false")
    {
        panic!("Android release requires --features custom-protocol to load the bundled UI");
    }
    tauri_build::build()
}

#[cfg(not(feature = "desktop"))]
fn main() {
    // Web 端不需要 tauri_build
}
