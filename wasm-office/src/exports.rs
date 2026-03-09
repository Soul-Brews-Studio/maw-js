//! WASM exports — functions JS calls to push data in and read state out.

use crate::store::{DATA, OUTPUT};
use crate::types::{AgentData, AgentStatus, DataStore};

// ============================================================
// JS → WASM: push data in
// ============================================================

/// Push agents. Format: "target|name|session|windowIdx|active|status|preview\n..."
#[no_mangle]
pub extern "C" fn wasm_push_agents(ptr: *const u8, len: usize) {
    let data = unsafe { std::str::from_utf8_unchecked(std::slice::from_raw_parts(ptr, len)) };
    let mut store = DATA.lock().unwrap();
    let store = store.get_or_insert_with(DataStore::new);
    store.agents.clear();
    for line in data.lines() {
        let parts: Vec<&str> = line.split('|').collect();
        if parts.len() < 7 { continue; }
        let agent = AgentData {
            target: parts[0].to_string(),
            name: parts[1].to_string(),
            session: parts[2].to_string(),
            window_index: parts[3].parse().unwrap_or(0),
            active: parts[4] == "1",
            status: AgentStatus::from_str(parts[5]),
            preview: parts[6].to_string(),
        };
        store.agents.insert(agent.target.clone(), agent);
    }
    store.recompute_rooms();
    store.recompute_stats();
}

/// Push saiyan targets. Format: "target1\ntarget2\n..."
#[no_mangle]
pub extern "C" fn wasm_push_saiyan(ptr: *const u8, len: usize) {
    let data = unsafe { std::str::from_utf8_unchecked(std::slice::from_raw_parts(ptr, len)) };
    let mut store = DATA.lock().unwrap();
    let store = store.get_or_insert_with(DataStore::new);
    store.saiyan_targets = data.lines().filter(|l| !l.is_empty()).map(|s| s.to_string()).collect();
}

// ============================================================
// Memory management for JS string passing
// ============================================================

#[no_mangle]
pub extern "C" fn wasm_alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

#[no_mangle]
pub extern "C" fn wasm_free(ptr: *mut u8, len: usize) {
    unsafe { drop(Vec::from_raw_parts(ptr, len, len)); }
}

// ============================================================
// WASM → JS: read state out
// ============================================================

/// Get popup state string pointer. Format: "visible|x|y|name|session|status|preview|color"
#[no_mangle]
pub extern "C" fn wasm_get_popup_ptr() -> *const u8 {
    OUTPUT.lock().unwrap().as_ptr()
}

#[no_mangle]
pub extern "C" fn wasm_get_popup_len() -> usize {
    OUTPUT.lock().unwrap().len()
}
