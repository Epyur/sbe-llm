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
| `getStatus` | `() => { configured: boolean; apiUrl: string }` | Готовность: `configured` = задан ключ и непустой `apiUrl` |
| `complete` | `(system: string, user: string, opts?: { model?: string; temperature?: number }) => Promise<string>` | Полный ответ текстом |
| `completeJson` | `<T>(system: string, user: string, opts?...) => Promise<T>` | Ответ парсится как JSON (извлечение блока; при не-JSON — один повтор «Верни ТОЛЬКО JSON») |
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
  "apiUrl": "https://ask.chadgpt.ru/api/v1/chat/completions",  // URL OpenAI-совместимого чат-эндпоинта
  "apiKeySecret": "sbe-llm-apikey"                             // имя секрета в secretStorage Obsidian
}
```

- Значение ключа хранится в `app.secretStorage` под стабильным именем `sbe-llm-apikey` (перезаписывается при изменении в настройках). ID секрета фиксированный, а не timestamp.
- `data.json` исключён из git (`.gitignore`).

## 5. Безопасность

- Ключ не логируется, не попадает в `data.json` и в сообщения об ошибках.
- Запросы только через `requestUrl` (не `fetch`).
- Эндпоинт `https://ask.chadgpt.ru/api/v1/chat/completions` — OpenAI-совместимый, формат запроса стандартный (`model`, `messages`, `temperature`).

## 6. Сборка и проверка

- `npm install` → `npm run build` (esbuild, бандл `src/main.ts` → `main.js`, склейка styles) → `npx tsc --noEmit` (EXIT=0).
- Включённые файлы релиза: `main.js`, `styles.css`, `manifest.json`, `README.md`.