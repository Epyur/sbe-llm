import { requestUrl, RequestUrlParam } from 'obsidian';
import { errorMessage } from '../../../sbe-core/src/utils/errors';

export interface LLMResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export interface LlmSettings {
  apiUrl: string;
  apiKeySecret: string;
}

/** Перенос ядра llm-service.ts из монолита yougile-tntn.
 *  Центр хранит только apiUrl и API-ключ (secretStorage). Модели и промты передаёт потребитель. */
export class LLMCenter {
  private settings: LlmSettings;
  private getSecret: (name: string) => string | null;
  private lastRequestTime = 0;
  private minRequestInterval = 2000;

  constructor(settings: LlmSettings, getSecret: (name: string) => string | null) {
    this.settings = settings;
    this.getSecret = getSecret;
  }

  /** Обновляет настройки (включая apiUrl) после их сохранения в плагине. */
  setSettings(settings: LlmSettings): void {
    this.settings = settings;
  }

  getApiKey(): string | null {
    return this.getSecret(this.settings.apiKeySecret);
  }

  getStatus(): { configured: boolean; apiUrl: string } {
    const configured = !!this.getApiKey() && !!this.settings.apiUrl?.trim();
    return { configured, apiUrl: this.settings.apiUrl };
  }

  private async retryWithBackoff<T>(fn: () => Promise<T>, maxRetries = 3, baseDelay = 3000): Promise<T> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        if (timeSinceLastRequest < this.minRequestInterval) {
          await new Promise(resolve => window.setTimeout(resolve, this.minRequestInterval - timeSinceLastRequest));
        }
        this.lastRequestTime = Date.now();
        return await fn();
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const err = error as { message?: string; status?: number };
        const retryable = err.status === 429 || err.status === 504
          || (typeof err.message === 'string'
            && (/(^|\s)(429|504)(\s|:|$)/.test(err.message) || err.message.startsWith('Timeout:')));
        if (retryable) {
          const delay = baseDelay * Math.pow(2, attempt);
          console.warn(`[SBE LLM] попытка ${attempt + 1} вернула ${err.message}, повтор через ${delay}ms...`);
          await new Promise(resolve => window.setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }
    }
    throw lastError || new Error('Превышено количество попыток');
  }

  async complete(system: string, user: string, opts?: { model?: string; temperature?: number }): Promise<string> {
    const apiKey = this.getApiKey();
    if (!apiKey) throw new Error('API ключ не настроен');
    const apiUrl = this.settings.apiUrl || 'https://ask.chadgpt.ru/api/v1/chat/completions';
    const model = opts?.model?.trim() || '';
    const temperature = opts?.temperature ?? 0.4;

    return this.retryWithBackoff(async () => {
      const response = await this.requestWithTimeout({
        url: apiUrl,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...(model ? { model } : {}),
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature,
        }),
      });

      if (response.status === 429) throw new Error('429: Too Many Requests');
      if (response.status !== 200) throw new Error(`HTTP ${response.status}: ${response.text}`);

      const data: LLMResponse = JSON.parse(response.text);
      return data.choices?.[0]?.message?.content || '';
    });
  }

  /** Vision-запрос: передаёт изображение (data URL или http(s)-URL) вместе с текстом.
   *  Формат сообщения user — массив {type:"text"|"image_url"}. Работает только с
   *  vision-моделями (например gpt-4o, gemini-*vision); обычные текстовые модели
   *  вернут HTTP 400. */
  async completeVision(
    system: string,
    user: string,
    imageUrl: string,
    opts?: { model?: string; temperature?: number },
  ): Promise<string> {
    const apiKey = this.getApiKey();
    if (!apiKey) throw new Error('API ключ не настроен');
    const apiUrl = this.settings.apiUrl || 'https://ask.chadgpt.ru/api/v1/chat/completions';
    const model = opts?.model?.trim() || '';
    const temperature = opts?.temperature ?? 0.4;

    return this.retryWithBackoff(async () => {
      const response = await this.requestWithTimeout({
        url: apiUrl,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...(model ? { model } : {}),
          messages: [
            { role: 'system', content: system },
            {
              role: 'user',
              content: [
                { type: 'text', text: user },
                { type: 'image_url', image_url: { url: imageUrl } },
              ],
            },
          ],
          temperature,
        }),
      });

      if (response.status === 429) throw new Error('429: Too Many Requests');
      if (response.status !== 200) throw new Error(`HTTP ${response.status}: ${response.text}`);

      const data: LLMResponse = JSON.parse(response.text);
      return data.choices?.[0]?.message?.content || '';
    });
  }

  /** Выполняет HTTP-запрос с клиентским таймаутом.
   *  requestUrl в Obsidian не имеет таймаута — без этой обёртки при зависшем
   *  сервере (даже без 504) промис не завершается никогда. */
  private async requestWithTimeout(
    param: RequestUrlParam,
    timeoutMs = 180000,
  ): Promise<{ status: number; text: string }> {
    let timer: number | undefined;
    try {
      const response = await Promise.race([
        requestUrl({ ...param, throw: false }),
        new Promise<never>((_, reject) => {
          timer = window.setTimeout(
            () => reject(new Error(`Timeout: LLM не ответил за ${Math.round(timeoutMs / 1000)} сек`)),
            timeoutMs,
          );
        }),
      ]);
      return { status: response.status, text: response.text };
    } finally {
      if (timer !== undefined) window.clearTimeout(timer);
    }
  }

  async completeJson<T>(system: string, user: string, opts?: { model?: string; temperature?: number }): Promise<T> {
    const text = await this.complete(system, user, opts);
    let parsed: unknown;
    try {
      parsed = this.extractJsonBlock(text);
    } catch (firstErr: unknown) {
      console.warn('SBE LLM: первый ответ не JSON, повторный запрос:', errorMessage(firstErr));
      const retry = await this.complete(
        system,
        'Предыдущий ответ не был валидным JSON. Верни ТОЛЬКО JSON по той же схеме.',
        opts,
      );
      parsed = this.extractJsonBlock(retry);
    }
    return parsed as T;
  }

  async ask(
    question: string,
    opts?: {
      system?: string;
      context?: string;
      history?: Array<{ role: 'user' | 'assistant'; text: string }>;
      model?: string;
    },
  ): Promise<string> {
    const apiKey = this.getApiKey();
    if (!apiKey) throw new Error('API ключ не настроен');
    const apiUrl = this.settings.apiUrl || 'https://ask.chadgpt.ru/api/v1/chat/completions';
    const model = opts?.model?.trim() || '';

    const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [];
    messages.push({ role: 'system', content: opts?.system || 'Ты — ассистент. Отвечай кратко и по делу.' });
    if (opts?.history) {
      for (const m of opts.history) {
        messages.push({ role: m.role, content: m.text });
      }
    }
    let userPrompt = question;
    if (opts?.context) {
      userPrompt = `## КОНТЕКСТ\n\n${opts.context}\n\n## ВОПРОС:\n${question}\n\n## ОТВЕТЬ:`;
    }
    messages.push({ role: 'user', content: userPrompt });

    return this.retryWithBackoff(async () => {
      const response = await this.requestWithTimeout({
        url: apiUrl,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...(model ? { model } : {}),
          messages,
          temperature: 0.3,
        }),
      });

      if (response.status === 429) throw new Error('429: Too Many Requests');
      if (response.status !== 200) throw new Error(`HTTP ${response.status}: ${response.text}`);

      const data: LLMResponse = JSON.parse(response.text);
      return data.choices?.[0]?.message?.content || 'Нет ответа от LLM';
    });
  }

  private extractJsonBlock(text: string): unknown {
    let cleaned = text.trim();
    const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) cleaned = fence[1].trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) throw new Error('JSON не найден в ответе LLM');
    return JSON.parse(cleaned.substring(start, end + 1));
  }
}
