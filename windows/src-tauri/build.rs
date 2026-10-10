fn main() {
    println!("cargo:rerun-if-env-changed=CHOOM_IDENTITY");
    println!("cargo:rerun-if-changed=../identity/choom-msix.manifest");
    if std::env::var("CHOOM_IDENTITY").as_deref() == Ok("1") {
        let windows = tauri_build::WindowsAttributes::new()
            .app_manifest(include_str!("../identity/choom-msix.manifest"));
        tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
            .expect("identity-enabled build failed");
    } else {
        tauri_build::build();
    }
}
