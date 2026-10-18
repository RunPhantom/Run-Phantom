fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["fixture_increment"])
    )).expect("Tauri fixture build unavailable");
}
