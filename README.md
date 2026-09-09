# cyclorithm-playground

WASM-плейграунд для Cyclorithm (v1 — визуализатор): редактор кода слева,
таймлайн (дорожки циклов-прямоугольников + точки событий) и таблица справа,
окно выбирается мышью, ошибки — панелью с выделением строки.

Движок — `../cycloritm` (path-зависимость; при публикации заменить на git URL,
см. `Cargo.toml`). Контракт: `expand_it(src, start, end, libs_json)` →
`{"ok":true,"result":{...}}` / `{"ok":false,"diag":{...}}`;
`expand_timeline` — то же плюс спаны (`event.span`, distinct-список `spans`).

## Сборка

Требуется `wasm-bindgen-cli` той же версии, что `wasm-bindgen` в `Cargo.toml`
(сейчас `0.2.100`):

```console
$ cargo build --release --target wasm32-unknown-unknown
$ wasm-bindgen target/wasm32-unknown-unknown/release/playground.wasm \
    --out-dir pkg --target web
$ python3 -m http.server 8080
# открыть http://localhost:8080
```

Тесты — в настоящем WASM под node (раннер `wasm-bindgen-test-runner`
из того же комплекта; переменная окружения — разово):

```console
$ export CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUNNER="wasm-bindgen-test-runner"
$ cargo test --target wasm32-unknown-unknown
```

## Ограничения v1 (честно)

- Библиотеки для `use` вшиты в `app.js` (`LIBS`); выбора файлов нет.
- Подсветка в редакторе — только выделение строки синтаксической ошибки;
  E-ошибки — текстом (у них нет позиций, см. `features/gui_editor.md`).
- Деплой на GitHub Pages — не настроен (следующий шаг после публикации репозитория).

## Публикация

1. `git init` здесь, первый коммит.
2. В `Cargo.toml` заменить path-зависимость на
   `cyclorithm-core = { git = "https://github.com/MaksPV/cyclorithm", branch = "main" }`
   (нужен запушенный коммит фасада `schedule.rs` в `main`).
3. Залить на GitHub, включить Pages (деплой из ветки или workflow со сборкой).
