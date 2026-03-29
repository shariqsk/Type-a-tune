use rdev::{listen, Event, EventType, Key};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc,
    Arc, Mutex,
};
use tauri::{Emitter, State};

#[derive(Serialize, Clone)]
struct GlobalKeypressPayload {
    key: String,
}

struct BackgroundListenerState {
    enabled: Arc<AtomicBool>,
    started: Arc<AtomicBool>,
}

fn keycode_to_js_key(key: &Key) -> Option<&'static str> {
    match key {
        Key::KeyA => Some("a"),
        Key::KeyB => Some("b"),
        Key::KeyC => Some("c"),
        Key::KeyD => Some("d"),
        Key::KeyE => Some("e"),
        Key::KeyF => Some("f"),
        Key::KeyG => Some("g"),
        Key::KeyH => Some("h"),
        Key::KeyI => Some("i"),
        Key::KeyJ => Some("j"),
        Key::KeyK => Some("k"),
        Key::KeyL => Some("l"),
        Key::KeyM => Some("m"),
        Key::KeyN => Some("n"),
        Key::KeyO => Some("o"),
        Key::KeyP => Some("p"),
        Key::KeyQ => Some("q"),
        Key::KeyR => Some("r"),
        Key::KeyS => Some("s"),
        Key::KeyT => Some("t"),
        Key::KeyU => Some("u"),
        Key::KeyV => Some("v"),
        Key::KeyW => Some("w"),
        Key::KeyX => Some("x"),
        Key::KeyY => Some("y"),
        Key::KeyZ => Some("z"),
        Key::Num0 => Some("0"),
        Key::Num1 => Some("1"),
        Key::Num2 => Some("2"),
        Key::Num3 => Some("3"),
        Key::Num4 => Some("4"),
        Key::Num5 => Some("5"),
        Key::Num6 => Some("6"),
        Key::Num7 => Some("7"),
        Key::Num8 => Some("8"),
        Key::Num9 => Some("9"),
        Key::Minus => Some("-"),
        Key::Equal => Some("="),
        Key::LeftBracket => Some("["),
        Key::RightBracket => Some("]"),
        Key::BackSlash => Some("\\"),
        Key::SemiColon => Some(";"),
        Key::Quote => Some("'"),
        Key::BackQuote => Some("`"),
        Key::Comma => Some(","),
        Key::Dot => Some("."),
        Key::Slash => Some("/"),
        Key::Space => Some(" "),
        Key::Return => Some("Enter"),
        Key::Backspace => Some("Backspace"),
        _ => None,
    }
}

#[tauri::command]
fn read_audio_file(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|error| error.to_string())
}

#[tauri::command]
fn enable_background_typing(
    app_handle: tauri::AppHandle,
    state: State<BackgroundListenerState>,
) {
    state.enabled.store(true, Ordering::Relaxed);

    if state.started.swap(true, Ordering::Relaxed) {
        return;
    }

    let enabled_flag = state.enabled.clone();
    let (tx, rx) = mpsc::channel::<String>();

    // Thread 1: receives keys from channel and emits to frontend.
    // Kept separate from the rdev callback so we never do Tauri IPC
    // inside the CGEventTap callback (crashes on macOS).
    let app_for_emit = app_handle.clone();
    std::thread::spawn(move || {
        while let Ok(key) = rx.recv() {
            let _ = app_for_emit.emit("global-keypress", GlobalKeypressPayload { key });
        }
    });

    // Thread 2: rdev event tap — callback only does a fast channel send.
    std::thread::spawn(move || {
        let ctrl_held = Arc::new(Mutex::new(false));
        let alt_held = Arc::new(Mutex::new(false));
        let meta_held = Arc::new(Mutex::new(false));

        let ctrl = ctrl_held.clone();
        let alt = alt_held.clone();
        let meta = meta_held.clone();

        let callback = move |event: Event| {
            if !enabled_flag.load(Ordering::Relaxed) {
                return;
            }
            match &event.event_type {
                EventType::KeyPress(key) => match key {
                    Key::ControlLeft | Key::ControlRight => {
                        *ctrl.lock().unwrap() = true;
                    }
                    Key::Alt | Key::AltGr => {
                        *alt.lock().unwrap() = true;
                    }
                    Key::MetaLeft | Key::MetaRight => {
                        *meta.lock().unwrap() = true;
                    }
                    _ => {
                        let no_modifiers = !*ctrl.lock().unwrap()
                            && !*alt.lock().unwrap()
                            && !*meta.lock().unwrap();
                        if no_modifiers {
                            if let Some(js_key) = keycode_to_js_key(key) {
                                let _ = tx.send(js_key.to_string());
                            }
                        }
                    }
                },
                EventType::KeyRelease(key) => match key {
                    Key::ControlLeft | Key::ControlRight => {
                        *ctrl.lock().unwrap() = false;
                    }
                    Key::Alt | Key::AltGr => {
                        *alt.lock().unwrap() = false;
                    }
                    Key::MetaLeft | Key::MetaRight => {
                        *meta.lock().unwrap() = false;
                    }
                    _ => {}
                },
                _ => {}
            }
        };

        if let Err(e) = listen(callback) {
            let _ = app_handle.emit(
                "global-keypress-error",
                format!("Keyboard listener failed: {:?}. Grant Input Monitoring in System Settings > Privacy & Security.", e),
            );
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(BackgroundListenerState {
            enabled: Arc::new(AtomicBool::new(false)),
            started: Arc::new(AtomicBool::new(false)),
        })
        .invoke_handler(tauri::generate_handler![read_audio_file, enable_background_typing])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
