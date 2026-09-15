# AGENTS.md — cyclorithm-playground

## Главное правило (строже, чем в cyclorithm)

- **Никаких push / PR / merge без показа результата владельцу.**
  Порядок всегда такой: правки → локальные проверки → показать diff +
  результаты проверок → ждать явного «пуш» / «пр» / «мерж».
- Самовольный мерж запрещён даже при зелёном CI. Урок: PR #4 был
  смержен без просьбы — так больше не делать.
- В cyclorithm push/PR разрешены по слову «делай»; здесь — нет:
  каждое действие с удалённым репозиторием только по прямому указанию.

## Источник правды

- Контракт фасада: `expand_it(src, start, end, libs_json)` →
  `{"ok":true,"result":{...}}` / `{"ok":false,"diag":{kind,code,line,col,text}}`;
  `expand_timeline` — то же плюс `event.span` и distinct-список `spans`.
  Контракт описан в `README.md:9-13` — семантику не дублировать в коде.
- Движок — чужой: `cyclorithm-core` из `MaksPV/cyclorithm`, ветка `dev`
  (фасад `core::api`: `run_schedule`/`run_timeline`/`next_steps`, `Diag`).
  Старый путь `core::schedule` удалён в ядре — не использовать.
- `app.js` — вшитые `LIBS` для `use`, выбора файлов нет (ограничение v1).

## Ветки и деплой

- `dev` — интеграция, `main` — релизная. Фичи — отдельными ветками в `dev`.
- Деплой сайта — только пушем в `main` (workflow `pages.yml`: сборка WASM
  в CI, `index.html` + `app.js` + `pkg/` → GitHub Pages).
- PR создавать с `base=dev` через `gh`; мерж — `--merge` и только по явному
  указанию (см. главное правило). Ветки после мержа не удалять без просьбы.

## Проверки после правок (локально, до показа результата)

- `cargo check` (хост) + `cargo check --target wasm32-unknown-unknown`.
- `wasm-bindgen` строго `=0.2.100` (версия в `Cargo.toml` = версии
  `wasm-bindgen-cli`, иначе клей рассыплется); `edition = "2024"`,
  `rust-version = "1.85"`.
- Тесты — только под WASM: `CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUNNER="wasm-bindgen-test-runner" cargo test --target wasm32-unknown-unknown`.
- Ручная проверка — `./run.sh [PORT]` (сборка + клей + сервер на 8080).

## Коммиты

- Сообщения — на русском, по содержимому, с суффиксом `, Muse Spark`
  (суффикс — модель, которой сделан коммит).
- Мелкими, по ходу работы; пуш — только по просьбе (см. главное правило).
- Терминал неинтерактивный: `rebase --continue` и подобные — только
  с `GIT_EDITOR=true` / `GIT_SEQUENCE_EDITOR=true`.

## Ловушки

- `pkg/` и `target/` — generated, руками не править (пересобираются `run.sh`).
- Порт занят — не гадать, просить другой (`./run.sh 8090`).
- Обновление `cyclorithm-core`: следить за `core::api` (урок: `schedule` →
  `api`, `parser` → внутрь `core`, edition 2021 → 2024) — после `cargo update`
  гнать обе проверки `check`.
