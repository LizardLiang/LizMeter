fn main() {
    println!("cargo:rerun-if-changed=lizmeter.rc");
    println!("cargo:rerun-if-changed=../../../build/icon.ico");
    // windres on the GNU toolchain, rc.exe on MSVC.
    #[cfg(windows)]
    embed_resource::compile("lizmeter.rc", embed_resource::NONE).manifest_optional().unwrap();
}
