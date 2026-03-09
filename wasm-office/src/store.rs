//! Global state — shared between exports (JS→WASM) and render loop.

use std::sync::Mutex;
use crate::types::DataStore;

/// Shared data store — exports write, render loop reads
pub static DATA: Mutex<Option<DataStore>> = Mutex::new(None);

/// Output buffer — render loop writes popup state, JS reads
pub static OUTPUT: Mutex<String> = Mutex::new(String::new());
