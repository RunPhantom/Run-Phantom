fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["fixture_increment", "fixture_ready", "fixture_rendered"])
    )).expect("Tauri fixture build unavailable");
}
