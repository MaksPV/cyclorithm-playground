# cyclorithm-playground

Живой сайт: https://MaksPV.github.io/cyclorithm-playground/

WASM-плейграунд для Cyclorithm (v1 — визуализатор): редактор кода слева,
таймлайн (дорожки циклов-прямоугольников + точки событий) и таблица справа,
окно выбирается мышью, ошибки — панелью с выделением строки.

Движок — `cyclorithm-core` из основного репозитория
(`https://github.com/MaksPV/cyclorithm`, ветка `dev` — интеграция, `main` — релиз, фасад `core::api`).
Контракт: `expand_it(src, start, end, libs_json)` →
`{"ok":true,"result":{...}}` / `{"ok":false,"diag":{...}}`;
`expand_timeline` — то же плюс спаны (`event.span`, distinct-список `spans`).

## Сборка

Быстрый запуск (проверка тулов, сборка WASM, клей, сервер на 8080):

```console
$ ./run.sh [PORT]
# открыть http://localhost:8080
```

Вручную (тот же конвейер по шагам).
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
- Деплой на GitHub Pages — workflow `.github/workflows/pages.yml`
  (сборка WASM в CI при пуше в `main`).

## Разработка

- Ветки: `dev` — интеграция, `main` — релизная (деплой сайта).
  Фичи — отдельными ветками в `dev`.
- Локальный запуск — `./run.sh [PORT]` (соберёт WASM из git-зависимости).
