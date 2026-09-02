# AGENTS.md — llm-service (LLM Center)

Go-сервис серверного хранения ключа API провайдера ИИ для SBE-плагина `sbe-llm`.
Контейнер `llm`, БД `llm` (postgres `llm-db`), авторизация — JWT HS256 (per-service
секрет `LLM_SERVICE_SECRET`, общий с auth-service), **без модели ролей** — валидный
JWT с `app_id=llm` достаточен для всех операций (каждая скопирована на email из
токена, чужой email недостижим). Деплой: `/opt/mailers/llm-service/`.

## Назначение

Каждый пользователь вводит свой ключ провайдера ИИ (например, chadgpt.ru) один раз —
в плагине или в веб-портале (`web/sbe-web/`) — ключ хранится на сервере, зашифрован,
привязан к email. Любой клиент, авторизованный тем же email, автоматически получает
доступ к тому же ключу через прокси-эндпоинты ниже, без повторного ввода.

- `GET /api/llm/health` — без авторизации, проверка БД.
- `GET /api/llm/settings` — статус: `{configured, api_url_override}`. **Значение ключа
  не возвращается никогда.**
- `POST /api/llm/settings` `{api_key, api_url?}` — шифрует (AES-256-GCM) и сохраняет
  ключ ТЕКУЩЕГО пользователя (upsert по email из JWT); `api_url` — опциональное
  переопределение провайдера для этого пользователя, пусто = `LLM_API_URL` по умолчанию.
- `DELETE /api/llm/settings` — удаляет ключ пользователя.
- `POST /api/llm/chat/completions` — находит ключ пользователя по email из JWT,
  расшифровывает, пересылает тело запроса КАК ЕСТЬ в `LLM_API_URL` (или
  пользовательский `api_url`) с `Authorization: Bearer <расшифрованный ключ>`,
  возвращает ответ провайдера как есть. Ключ не настроен → `400 {"error": "llm key
  not configured"}`. Rate-limit по email (не по IP) — `ratelimit.go`.
- `GET /api/llm/models` — тем же ключом пользователя запрашивает `LLM_MODELS_URL`,
  возвращает список моделей провайдера (id, цены за млн токенов, `is_old_model`) как
  есть — для выпадающих списков в настройках плагинов-потребителей.
- Таблица `user_llm_keys` (`email` PK, `api_key_enc`, `api_key_nonce`, `api_url`,
  `created_at`, `updated_at`).

## Шифрование

- `crypto.go` — AES-256-GCM, стандартная библиотека (`crypto/aes`+`crypto/cipher`),
  без сторонних зависимостей. Ключ шифрования — `LLM_KEY_ENCRYPTION_KEY` (32 байта,
  base64, `openssl rand -base64 32`), **отдельно** от `LLM_SERVICE_SECRET` и паролей
  БД (защита в глубину — дамп БД сам по себе ключи не раскрывает).
- Ключ провайдера НЕ логируется нигде (ни access-логи, ни `log.Printf` при ошибках
  прокси) и не возвращается клиенту ни одним эндпоинтом после сохранения.
- Разовая миграция при выкатке невозможна в принципе: сервер никогда не видел старые
  локальные ключи (`app.secretStorage` каждой установки плагина) — каждый пользователь
  вводит ключ заново один раз, в плагине или в веб-версии.

## Конфиг (env)

`DATABASE_URL`, `PORT`, `LLM_APP_ID` (default `llm`), `LLM_APP_NAME`, `LLM_OWNER_EMAIL`,
`LLM_SERVICE_SECRET`, `AUTH_SERVICE_URL`, `LLM_KEY_ENCRYPTION_KEY`, `LLM_API_URL`
(default `https://ask.chadgpt.ru/api/v1/chat/completions`), `LLM_MODELS_URL` (default
`https://ask.chadgpt.ru/api/v1/models`, сознательно отдельная переменная, а не
производная от `LLM_API_URL` строковой манипуляцией).

## Сборка / проверка

```
docker compose up -d --build llm        # на сервере
docker compose exec llm wget -qO- http://localhost:3000/health
```

- `go build ./...` / `go vet ./...` — EXIT=0.
- Зависимости: `golang-jwt/jwt/v5` (MIT), `jackc/pgx/v5` (MIT) — только свободные
  лицензии (правило корневого `AGENTS.md`).

## История

### 2026-09-02 — создание (v0.1.5b плагина sbe-llm)
- Сервис создан с нуля: `jwt.go`/`crypto.go`/`settings.go`/`proxy.go`/`models.go`/
  `register.go`, миграция `user_llm_keys`. Развёрнут на проде: `llm-db`+`llm` в
  `docker-compose.yml` (см. `sbe-core/docker/AGENTS.md`), `auth-service` пересобран
  с регистрацией приложения `llm` (`sbe-core/auth-service/AGENTS.md`), Caddy
  `/api/llm/*` → `llm:3000`. Роль `llm_app` в БД — `NOSUPERUSER`, `LOGIN`,
  `GRANT CREATE, USAGE ON SCHEMA public` (сервис создаёт свою таблицу сам и
  становится её владельцем — без `photo_app`-style `ALTER DEFAULT PRIVILEGES`,
  он там не был обязательным механизмом).
- E2E на реальном ключе провайдера (chadgpt.ru, `gpt-4.1-mini`): сохранение ключа →
  `GET /settings` → `configured:true` → чат-запрос вернул реальный ответ модели →
  `GET /models` вернул полный список с ценами → `DELETE` → `GET /settings`
  → `configured:false` → чат-запрос без ключа → `400`.
- Тестовые устройство/ключ в auth-db удалены после проверки.

## Правила

- `catch(e: unknown)` + оборачивать в понятную ошибку; ключ провайдера никогда не
  логировать и не возвращать клиенту; только свободные Go-зависимости (MIT/BSD/Apache).
- Коммиты/пуши — только по явной команде пользователя.
