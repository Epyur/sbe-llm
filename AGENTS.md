# AGENTS.md — sbe-llm (SBE LLM Center)

Центральный LLM-сервис системы SBE: хранит только `apiUrl` и API-ключ (secretStorage).
Модели, промты и контекст передаёт потребитель (например, `sbe-presentations`).

## Публикация

- Сервис публикуется как `sbe-llm` в `window.SBE` при `onload`, снимается в `onunload`.
- Потребители получают его через `getService('sbe-llm')` (sbe-core bridge, поллинг 200 мс, таймаут 15 с).

## Структура

- `src/services/llm-center.ts` — ядро: `complete`, `completeJson`, `ask`, ретраи с бэкффом (429/504, мин. интервал 2 с), клиентский таймаут 180 с (обёртка `requestWithTimeout` над `requestUrl` — у того нет таймаута), извлечение JSON из ответа с одним повтором при не-JSON.
- `src/ui/settings-tab.ts` — настройки: URL API, API-ключ (password, секрет `sbe-llm-apikey`, стабильный ID — перезаписывается), проверка состояния.
- `src/main.ts` — `SbeLlmPlugin`: публикует `SbeLlmApi`, читает секреты через `app.secretStorage`.

## История работ

### 2026-08-15 — v0.1.1 (sbe-tasks)
- Пересборка `main.js` после расширения sbe-core (`SbeYougileApi.client`,
  `SbeTasksApi`). Исходники не менялись.
- Версия 0.1.0 → **0.1.1** (manifest + package.json).
- `npx tsc --noEmit` EXIT=0; `npm run build` OK.

### 2026-08-14 — v0.1.0 (создание)
- Плагин создан в рамках выноса модулей из монолита `yougile-tntn` (дизайн: `docs/superpowers/specs/2026-08-14-sbe-llm-presentations-design.md`).
- Ядро перенесено из `yougile-tntn/src/services/llm-service.ts` и почищено: убран `resolveModel`/модели/промты из центра — модель передаётся в каждый вызов, промты у потребителя.
- `SbeLlmApi` в `sbe-core/src/types.ts` обновлён под новую границу (см. также `sbe-core/AGENTS.md`).
- Паттерн API-ключа взят из монолита: один стабильный секрет `sbe-llm-apikey`, перезаписывается при изменении (не плодим секреты).
- Сборка: `npm run build` → `main.js` + `styles.css` (tokens+components sbe-core склеиваются через `build.onEnd`). `npx tsc --noEmit` EXIT=0.

## Статистика ошибок и отступлений

- Нарушений правил нет: `window.setTimeout` — корректный префикс; `instanceof
  Error` в `llm-center.ts:52` — type guard приведения `unknown` → `Error`, а не
  инлайн-извлечение сообщения. 0 `any`, 0 `fetch`, 0 инлайн-стилей.
- Сборка и типы — без ошибок и предупреждений.

## Правила

- `catch(e: unknown)` + `errorMessage()`; `requestUrl()`; `window.setTimeout()`; без `any`; UI на русском; автор плагина — Полищук Евгений (polishchuk@tn.ru).