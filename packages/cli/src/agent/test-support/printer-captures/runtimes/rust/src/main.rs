// Rust capture (printer captures, FAKE values only). Reads {c, v} JSON lines on stdin; writes {p, c, hex}.
use std::io::{self, BufRead, Write};
fn hex(s: &str) -> String { s.as_bytes().iter().map(|b| format!("{:02x}", b)).collect() }
#[derive(Debug)]
#[allow(dead_code)]
struct S { s: String }
fn main() {
    let stdin = io::stdin();
    let mut out = io::BufWriter::new(io::stdout());
    for line in stdin.lock().lines() {
        let line = line.unwrap();
        if line.is_empty() { continue; }
        let inp: serde_json::Value = match serde_json::from_str(&line) { Ok(x) => x, Err(e) => { eprintln!("input error: {}", e); continue; } };
        let c = inp["c"].as_str().unwrap().to_string();
        let v = inp["v"].as_str().unwrap().to_string();
        let mut emit = |p: &str, o: String| {
            let row = serde_json::json!({"p": p, "c": c, "hex": hex(&o)});
            writeln!(out, "{}", row).unwrap();
        };
        emit("rust.debug_str", format!("{:?}", v.as_str()));
        emit("rust.debug_String", format!("{:?}", v));
        emit("rust.debug_struct", format!("{:?}", S { s: v.clone() }));
        emit("rust.serde_json.to_string", serde_json::to_string(&v).unwrap());
        emit("rust.str.escape_debug", v.escape_debug().to_string());
        emit("rust.str.escape_default", v.escape_default().to_string());
    }
}
