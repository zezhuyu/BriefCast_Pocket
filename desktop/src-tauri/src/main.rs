// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::process::Command;
use std::{thread, time::Duration};
use std::net::TcpStream;

fn wait_for_backend(port: u16, timeout_secs: u64) -> bool {
    let start = std::time::Instant::now();
    while start.elapsed().as_secs() < timeout_secs {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        thread::sleep(Duration::from_millis(200));
    }
    false
}

fn main() {
  tauri::Builder::default()
  .setup(|_app| {
    let port = 5002;
    if TcpStream::connect(("127.0.0.1", port)).is_err() {
        // Only start backend if not already running
        Command::new("../../backend/dist/api")
            .spawn()
            .expect("Failed to start Python backend");

        // Wait until it's ready
        let ready = wait_for_backend(port, 60);
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
