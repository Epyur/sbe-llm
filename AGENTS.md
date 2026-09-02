# AGENTS.md — sbe-llm (SBE LLM Center)

Центральный LLM-сервис системы SBE: хранит только `apiBase` (адрес стека SBE). Ключ
провайдера — на сервере (`llm-service`), зашифрован, привязан к email пользователя (см.
`llm-service/AGENTS.md`). Модели, промты и контекст передаёт потребитель (например, `sbe-presentations`).

## Публикация

- Сервис публикуется как `sbe-llm` в `window.SBE` при `onload`, снимается в `onunload`.
- Потребители получают его через `getService('sbe-llm')` (sbe-core bridge, поллинг 200 мс, таймаут 15 с).

## Структура

- `src/services/llm-center.ts` — ядро: `getStatus`/`setApiKey`/`deleteApiKey`/`listModels`
  (управление ключом на сервере), `complete`, `completeVision`, `completeJson`, `ask`
  (все — через `POST /api/llm/chat/completions`, ключ подставляет сервер), ретраи с
  бэкффом (429/504, мин. интервал 2 с), клиентский таймаут 180 с (обёртка
  `requestWithTimeout` над `requestUrl` — у того нет таймаута), извлечение JSON из
  ответа с одним повтором при не-JSON.
- `src/ui/settings-tab.ts` — настройки: URL стека, ввод/сохранение ключа провайдера на
  сервере, проверка состояния (`GET /api/llm/settings`), удаление ключа.
- `src/main.ts` — `SbeLlmPlugin`: публикует `SbeLlmApi`, JWT для `llm-service` через
  `getService('sbe-apstore').auth.getToken('llm')` — ключ провайдера плагин не хранит.
- `llm-service/` (ветка `backend`) — Go-бэкенд: `crypto.go` (AES-256-GCM),
  `settings.go`/`proxy.go`/`models.go` (эндпоинты), `jwt.go`/`register.go`
  (тот же паттерн auth, что у `photo-service`/`lab-service`, но без модели ролей —
  все операции скопированы на email из JWT). Таблица `user_llm_keys` (email → шифрованный
  ключ). Развёрнут на проде (`llm-db`+`llm` в `docker-compose.yml`, Caddy `/api/llm/*`).

## История работ

### 2026-09-02 — v0.1.5b (серверное хранение ключа, привязанного к пользователю)
- **Архитектурный перенос**: ключ провайдера ИИ убран из `app.secretStorage` плагина,
  теперь хранится ТОЛЬКО на сервере (новый `llm-service`, AES-256-GCM), привязан к email
  пользователя — настроенный один раз ключ автоматически доступен в любом плагине и в
  веб-портале (`web/sbe-web/`, отдельный git-репо). Дизайн и обоснование —
  `docs/superpowers/plans/...` (план оценки задачи, сессия 2026-09-02).
- `SbeLlmApi.getStatus()` — единственное изменение публичного интерфейса: синхронный →
  `Promise<{configured, apiUrl}>` (живой запрос на сервер вместо локальной проверки).
  Потребители: `sbe-photobank` (`ai-describe.service.ts`, 3 места) поправлен под `await`.
- Новые серверные эндпоинты: `GET/POST/DELETE /api/llm/settings` (статус/сохранение/
  удаление ключа — ключ никогда не возвращается клиенту), `POST /api/llm/chat/completions`
  (прокси с подстановкой ключа пользователя), `GET /api/llm/models` (список моделей
  провайдера — цены, `is_old_model`, для выпадающих списков у потребителей).
- `announceUpdate()` подключён (было готово с 2026-08-22, но не вызывалось) — публикует
  новость в «Новости» ЦУП при первой загрузке новой версии (`lastAnnouncedVersion`
  в `data.json`).
- Развёртка на проде: новые `llm-db`+`llm` в `docker-compose.yml`, Caddy `/api/llm/*` →
  `llm:3000`, `auth-service` пересобран (регистрация приложения `llm` в `seed.go`,
  см. `sbe-core/AGENTS.md`). E2E проверен на реальном ключе провайдера (chadgpt.ru):
  сохранение → статус → чат-запрос → удаление → корректная ошибка без ключа.
- Версия 0.1.4 → **0.1.5b** (manifest + package.json; суффикс `b` — версия ещё не
  синхронизирована с `main`, см. правило в корневом `AGENTS.md`). `npx tsc --noEmit`
  EXIT=0, `npm run build` OK.

### 2026-08-29 — v0.1.4 (completeVision)
- `SbeLlmApi.completeVision(system, user, imageUrl, opts)` — vision-запрос: передаёт
  изображение (data URL или http(s)-URL) в chat-формате OpenAI
  (`content: [{type:"text"}, {type:"image_url"}]`). Работает только с vision-моделями
  (например gpt-4o); текстовые модели и модели Image API chad (gemini-*-image, gpt-img-*)
  вернут 400. Потребитель — sbe-photobank (ИИ-описание с реальными цветами/материалами).
- Версия 0.1.3 → **0.1.4** (manifest + package.json). `npx tsc --noEmit` EXIT=0,
  `npm run build` OK. Реестр: hashes sbe-llm добавлены, синхронизированы.

## История работ

### 2026-08-17 — v0.1.2 (источник реестра)
- `sbe-core`: `DEFAULT_REGISTRY_URL` → `https://epyur.fvds.ru/registry.json`
  (raw.githubusercontent.com отдавал 429, реестр в ЦУП пропадал).
- Пересборка `main.js`. Исходники не менялись.
- Версия 0.1.1 → **0.1.2** (manifest + package.json).
- `npx tsc --noEmit` EXIT=0; `npm run build` OK.

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