# specification.md — sbe-llm (SBE LLM Center)

## 1. Идентификация

- `manifest.id`: `sbe-llm`
- Имя: SBE LLM Center
- Автор: Полищук Евгений (polishchuk@tn.ru)
- Зависимость от `sbe-core` (только при сборке, рантайм автономен)

## 2. Публикуемый сервис (мост `window.SBE`)

Идентификатор сервиса: `sbe-llm` (тип `SbeLlmApi` в `sbe-core/src/types.ts`).

| Метод | Сигнатура | Описание |
|---|---|---|
| `getStatus` | `() => Promise<{ configured: boolean; apiUrl: string }>` | Готовность — живой запрос на сервер (`GET /api/llm/settings`), не локальная проверка; `configured` = у ТЕКУЩЕГО пользователя (по email из JWT) настроен ключ |
| `complete` | `(system: string, user: string, opts?: { model?: string; temperature?: number }) => Promise<string>` | Полный ответ текстом |
| `completeJson` | `<T>(system: string, user: string, opts?...) => Promise<T>` | Ответ парсится как JSON (извлечение блока; при не-JSON — один повтор «Верни ТОЛЬКО JSON») |
| `completeVision` | `(system: string, user: string, imageUrl: string, opts?: { model?: string; temperature?: number }) => Promise<string>` | Vision-запрос: изображение (data URL или http(s)-URL) передаётся в chat-формате OpenAI; только для vision-моделей |
| `ask` | `(question: string, opts?: { system?: string; context?: string; history?: Array<{role:'user'\|'assistant'; text:string}>; model?: string }) => Promise<string>` | Диалог с контекстом и историей |

### Контракты и ограничения

- `model`: если не передано/пусто — дефолт центра `deepseek-v4-pro`. Потребитель должен явно передавать выбранную модель.
- `temperature`: `complete`/`completeJson` по умолчанию `0.4`, `ask` — `0.3`.
- Промты (system-промпты, design rules и т.д.) центр НЕ знает — их передаёт потребитель.
- RAG по письмам в центре НЕТ (остался в монолите `yougile-tntn`).

## 3. Ошибки и ретраи

- HTTP 429/504 и клиентский таймаут → экспоненциальный бэкфф (3 с × 2^n, до 3 попыток), минимальный интервал между запросами 2 с.
- Клиентский таймаут запроса: **180 с** (обёртка `requestWithTimeout`; у `requestUrl` таймаута нет).
- Ошибки: `throw new Error('API ключ не настроен')` при отсутствии ключа; `HTTP <code>: <text>` при не-200; `Timeout: LLM не ответил за N сек`.
- Потребитель получает ошибку через reject промиса и показывает её пользователю.

## 4. Настройки (`data.json`)

```ts
{
  "apiBase": "https://epyur.fvds.ru",   // адрес СТЕКА SBE (llm-service за Caddy) — НЕ адрес провайдера
  "lastAnnouncedVersion": ""            // версия, для которой уже опубликована новость в «Новости» ЦУП
}
```

- **2026-09-02: ключ провайдера ИИ больше не хранится в плагине.** Раньше — стабильный
  секрет `sbe-llm-apikey` в `app.secretStorage`; теперь ключ вводится один раз (в
  плагине или в веб-версии) и хранится ТОЛЬКО на сервере (`llm-service`), зашифрованный,
  привязанный к email пользователя (см. `llm-service/AGENTS.md`). Плагин ключ провайдера
  не видит и не хранит — обращается к `llm-service` своим JWT (`app_id=llm`).
- `data.json` исключён из git (`.gitignore`).

## 5. Безопасность

- Ключ провайдера не логируется НИГДЕ (ни в плагине, ни на сервере) и никогда не
  возвращается клиенту после сохранения — эндпоинты `/api/llm/settings` только
  пишут/удаляют/сообщают статус (`configured: true/false`), не читают значение обратно.
- Хранение на сервере — AES-256-GCM, ключ шифрования (`LLM_KEY_ENCRYPTION_KEY`) отдельно
  от паролей БД и `LLM_SERVICE_SECRET` (защита в глубину). Подробности — `llm-service/AGENTS.md`.
- Запросы плагина к `llm-service` — через `requestUrl` (не `fetch`), с JWT
  (`getService('sbe-apstore').auth.getToken('llm')`), не напрямую к провайдеру.
- `llm-service` пересылает тело запроса провайдеру как есть, подставив расшифрованный
  ключ ТЕКУЩЕГО пользователя в `Authorization` — формат запроса провайдеру не меняется
  (`model`, `messages`, `temperature`, OpenAI-совместимый).

## 6. Управление ключом (только внутри плагина, не часть `SbeLlmApi`)

`LLMCenter` (используется `ui/settings-tab.ts`, потребителям через `getService('sbe-llm')`
недоступно — не часть публикуемого интерфейса):

- `setApiKey(apiKey, apiUrl?)` — `POST /api/llm/settings`, email берётся сервером из JWT.
- `deleteApiKey()` — `DELETE /api/llm/settings`.
- `listModels()` — `GET /api/llm/models`: список моделей провайдера (цены,
  `is_old_model`) для выпадающих списков в настройках плагинов-потребителей.

## 7. Сборка и проверка

- `npm install` → `npm run build` (esbuild, бандл `src/main.ts` → `main.js`, склейка styles) → `npx tsc --noEmit` (EXIT=0).
- Включённые файлы релиза: `main.js`, `styles.css`, `manifest.json`, `README.md`.