use std::fs;
use std::path::{Path};

fn main() {
    let out_dir = Path::new("./");
    let api_path = Path::new("../../backend/dist/api");

    if api_path.exists() && api_path.is_file() {
        println!("✅ API file exists: {}", api_path.display());
    } else {
        println!("❌ API file does not exist: {}", api_path.display());
        panic!("API binary not found");
    }

    if out_dir.exists() {
        println!("✅ Output path exists: {}", out_dir.display());
    } else {
        println!("📁 Creating output directory: {}", out_dir.display());
        fs::create_dir_all(&out_dir).expect("Failed to create output directory");
    }

    let dest_path = out_dir.join("api");

    fs::copy(api_path, &dest_path)
        .expect(&format!("❌ Failed to copy API binary to {}", dest_path.display()));

    println!("✅ Copied backend binary to {}", dest_path.display());
    tauri_build::build()
}