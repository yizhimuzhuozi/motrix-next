fn main() {
    // On macOS, clear quarantine flags from sidecar binaries so they can execute
    #[cfg(target_os = "macos")]
    {
        let binaries_dir = std::path::Path::new("binaries");
        if binaries_dir.exists() {
            let _ = std::process::Command::new("xattr")
                .args(["-cr", "binaries/"])
                .status();
        }
    }

    tauri_build::build()
}
