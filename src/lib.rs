//! WASM-обёртка над движком для плейграунда (v1 — визуализатор).
//!
//! Экспорты `expand_it` / `expand_timeline`: исходник + окно + библиотеки
//! (`use` из памяти) → JSON-конверт `{"ok":true,"result":{...}}` или
//! `{"ok":false,"diag":{"kind","code","line","col","text"}}`.
//! `expand_timeline` добавляет спаны: у каждого события — `span`,
//! плюс distinct-список `spans` для прямоугольников таймлайна.

use cyclorithm_core::api::{Diag, run_schedule, run_timeline};
use wasm_bindgen::prelude::*;

type Run = fn(&str, &str, &str, &[(&str, &str)]) -> Result<String, Diag>;

/// Развернуть расписание. `libs_json` — `[["путь","текст"],...]`,
/// путь как в `use` (например `"libs/route_lib.cyclo"`).
#[wasm_bindgen]
pub fn expand_it(src: &str, start: &str, end: &str, libs_json: &str) -> String {
    call(run_schedule, src, start, end, libs_json)
}

/// Развернуть расписание для таймлайна (события со спанами + список спанов).
#[wasm_bindgen]
pub fn expand_timeline(src: &str, start: &str, end: &str, libs_json: &str) -> String {
    call(run_timeline, src, start, end, libs_json)
}

fn call(run: Run, src: &str, start: &str, end: &str, libs_json: &str) -> String {
    let libs: Vec<(String, String)> = match serde_json::from_str(libs_json) {
        Ok(v) => v,
        Err(e) => {
            return serde_json::json!({
                "ok": false,
                "diag": {"kind": "usage", "code": null, "line": null, "col": null,
                         "text": format!("bad libs_json: {e}")},
            })
            .to_string();
        }
    };
    let refs: Vec<(&str, &str)> = libs
        .iter()
        .map(|(name, text)| (name.as_str(), text.as_str()))
        .collect();
    match run(src, start, end, &refs) {
        Ok(json) => format!("{{\"ok\":true,\"result\":{json}}}"),
        Err(d) => serde_json::json!({
            "ok": false,
            "diag": {"kind": d.kind, "code": d.code, "line": d.line, "col": d.col,
                     "text": d.text},
        })
        .to_string(),
    }
}

/// Конверт для тестов (та же строка, что уйдёт в JS).
pub fn expand_envelope(
    run: Run,
    src: &str,
    start: &str,
    end: &str,
    libs: &[(&str, &str)],
) -> String {
    let owned: Vec<(String, String)> = libs
        .iter()
        .map(|(n, t)| ((*n).to_owned(), (*t).to_owned()))
        .collect();
    let libs_json = serde_json::to_string(&owned).expect("libs сериализуются");
    call(run, src, start, end, &libs_json)
}

/// Тесты живут только под wasm32 (раннер `wasm-bindgen-test-runner`):
/// на хосте им нечего исполнять.
#[cfg(all(test, target_arch = "wasm32"))]
mod tests {
    use super::*;
    use wasm_bindgen_test::*;

    const MINI: &str = r#"schedule "Тест" {
  point DEPOT {
    actions = [depart, arrive];
  }

  cycle HOP
    duration = 20m
  {
    0m: DEPOT.depart();
    20m: DEPOT.arrive();
  }

  root_cycle
    start_time = "2026-01-01T00:00:00",
    duration = 24h
  {
    [not weekend(at)] 6h: HOP();
  }
}"#;

    #[wasm_bindgen_test]
    fn envelope_ok_parses_and_carries_events() {
        let out = expand_envelope(
            run_schedule,
            MINI,
            "2026-01-09T00:00:00",
            "2026-01-10T00:00:00",
            &[],
        );
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["result"]["events"].as_array().unwrap().len(), 2);
    }

    #[wasm_bindgen_test]
    fn envelope_err_carries_diag() {
        let out = expand_envelope(
            run_schedule,
            "schedule {",
            "2026-01-09T00:00:00",
            "2026-01-10T00:00:00",
            &[],
        );
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["ok"], false);
        assert_eq!(v["diag"]["kind"], "parse");
        assert_eq!(v["diag"]["line"], 1);
    }

    #[wasm_bindgen_test]
    fn fill_gaps_comes_from_current_engine() {
        // Модификатор fill gaps: без until добивает пустоты до конца цикла.
        let src = "schedule \"T\" { point A { actions = [x]; } \
            cycle R duration = 1h { 0m: A.x(); } \
            root_cycle start_time = \"2026-01-01T00:00:00\", duration = 24h \
            { 0h: R(); 0h: fill gaps R(); } }";
        let out = expand_envelope(
            run_schedule,
            src,
            "2026-01-01T00:00:00",
            "2026-01-02T00:00:00",
            &[],
        );
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["ok"], true);
        // 0:00 занято, дальше каждый час: 1:00 … 23:00 — 24 события.
        let events = v["result"]["events"].as_array().unwrap();
        assert_eq!(events.len(), 24);
        assert_eq!(events[23]["time"], "2026-01-01T23:00:00");
    }

    #[wasm_bindgen_test]
    fn naive_window_inherits_file_zone_walls_stand() {
        // Файл с городом + наивное окно: движок читает наивное как стены
        // в зоне файла (кадр, PR #39), а отвечает в зоне файла с суффиксом.
        let src = "schedule \"T\" { timezone = \"+03:00\", \
            point A { actions = [x]; } \
            cycle R duration = 1h { 0m: A.x(); } \
            root_cycle start_time = \"2026-01-01T06:00:00\", duration = 24h \
            { 0h: R(); } }";
        let out = expand_envelope(
            run_schedule,
            src,
            "2026-01-01T00:00:00",
            "2026-01-02T00:00:00",
            &[],
        );
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["ok"], true);
        let events = v["result"]["events"].as_array().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["time"], "2026-01-01T06:00:00+03:00");
    }

    #[wasm_bindgen_test]
    fn aware_window_answers_with_suffix() {
        // Тот же файл, окно с явным поясом: ответ с суффиксом зоны окна.
        let src = "schedule \"T\" { timezone = \"+03:00\", \
            point A { actions = [x]; } \
            cycle R duration = 1h { 0m: A.x(); } \
            root_cycle start_time = \"2026-01-01T06:00:00\", duration = 24h \
            { 0h: R(); } }";
        let out = expand_envelope(
            run_schedule,
            src,
            "2026-01-01T00:00:00+03:00",
            "2026-01-02T00:00:00+03:00",
            &[],
        );
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["ok"], true);
        let events = v["result"]["events"].as_array().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["time"], "2026-01-01T06:00:00+03:00");
    }

    #[wasm_bindgen_test]
    fn timeline_envelope_carries_spans() {
        let src = "schedule \"T\" { point A { actions = [x]; } \
            cycle HOP duration = 20m { 0m: A.x(); 20m: A.x(); } \
            root_cycle start_time = \"2026-01-01T00:00:00\", duration = 24h \
            { 6h: HOP(); 8h: A.x(); } }";
        let out = expand_envelope(
            run_timeline,
            src,
            "2026-01-01T00:00:00",
            "2026-01-02T00:00:00",
            &[],
        );
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["ok"], true);
        let spans = v["result"]["spans"].as_array().unwrap();
        assert_eq!(spans.len(), 2);
        assert_eq!(spans[0]["cycle"], "root_cycle");
        assert_eq!(spans[1]["cycle"], "HOP");
        assert_eq!(v["result"]["events"][0]["span"]["cycle"], "HOP");
        assert_eq!(v["result"]["events"][2]["span"]["cycle"], "root_cycle");
    }
}
