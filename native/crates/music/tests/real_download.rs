//! Downloads the real yt-dlp and ffmpeg from GitHub into `LIZMETER_TEST_USERDATA` (a scratch
//! folder) and runs the same checksum path the app uses. Ignored: it needs the network and moves
//! about 100 MB. Run with `cargo test -p lizmeter-music --test real_download -- --ignored --nocapture`.
use lizmeter_music::binaries::BinaryManager;

#[test]
#[ignore]
fn downloads_and_verifies_the_real_binaries() {
    let dir = std::env::var("LIZMETER_TEST_USERDATA").expect("set LIZMETER_TEST_USERDATA to a scratch folder");
    let mgr = BinaryManager::new(std::path::Path::new(&dir));
    let info = mgr.info();
    println!("info: {info:?}");
    assert!(info.error.is_none(), "{:?}", info.error);
    let mut last = (String::new(), 0.0);
    mgr.download(&mut |p| {
        if p.binary != last.0 || p.percent - last.1 >= 25.0 || p.percent == 100.0 {
            println!("{} {}% ({} of {} bytes, {} B/s)", p.binary, p.percent, p.bytes_downloaded, p.total_bytes, p.speed);
            last = (p.binary.clone(), p.percent);
        }
    })
    .expect("download with checksum verification");
    let status = mgr.check();
    println!("status: {status:?}");
    assert!(status.yt_dlp_installed && status.ffmpeg_installed);
}
