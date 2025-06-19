// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::process::Command;
use std::{thread, time::Duration};
use std::net::TcpStream;
use std::path::PathBuf;
use std::env;

fn get_bundled_resource_path(file: &str) -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        // /Applications/BriefCast.app/Contents/Resources/api
        let exe_path = env::current_exe().expect("Failed to get exe path");
        exe_path
            .parent().unwrap() // MacOS/
            .parent().unwrap() // Contents/
            .join("Resources")
            .join(file)
    }

    #[cfg(target_os = "windows")]
    {
        // exe is next to resources/
        let exe_path = env::current_exe().expect("Failed to get exe path");
        exe_path
            .parent().unwrap()
            .join("resources")
            .join(file)
    }

    #[cfg(target_os = "linux")]
    {
        // Linux structure may vary; fallback to relative path
        PathBuf::from(format!("./resources/{}", file))
    }
}


fn wait_for_backend(port: u16, attempts: u32, attempt_timeout_secs: u64) -> bool {
    for i in 1..=attempts {
        println!("🔄 Waiting for backend attempt {}/{}...", i, attempts);
        let start = std::time::Instant::now();
        while start.elapsed().as_secs() < attempt_timeout_secs {
            if TcpStream::connect(("127.0.0.1", port)).is_ok() {
                println!("✅ Backend is ready!");
                return true;
            }
            thread::sleep(Duration::from_millis(200));
        }
        println!("⚠️ Attempt {} timed out after {}s", i, attempt_timeout_secs);
    }
    println!("❌ Backend failed to respond after {} attempts.", attempts);
    false
}

fn main() {
    tauri::Builder::default()
        .setup(|_| {
            let port = 5002;
            
            // Get the path to the backend executable
            let path: PathBuf = if cfg!(debug_assertions) {
                PathBuf::from("../../backend/dist/api")
            } else {
                get_bundled_resource_path("api")
            };

            if TcpStream::connect(("127.0.0.1", port)).is_err() {
                // Only start backend if not already running
                Command::new(&path)
                    .spawn()
                    .map_err(|e| format!("Failed to start Python backend: {}", e))?;

                // Wait until it's ready
                let ready = wait_for_backend(port, 10, 10);
                if !ready {
                    return Err("Backend failed to start in time".into());
                }
            } else {
                println!("Backend already running on port {}", port);
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
