import { requestUrl, RequestUrlParam } from 'obsidian';
import { errorMessage } from '../../../sbe-core/src/utils/errors';

export interface LLMResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export interface LlmModel {
  id: string;
  owned_by: string;
  input_cost_per_million_tokens: string | null;
  output_cost_per_million_tokens: string | null;
  is_old_model: boolean;
}

export interface LlmSettings {
  /** Адрес сервера SBE (llm-service живёт за тем же Caddy, что и остальные сервисы) — НЕ адрес провайдера. */
  apiBase: string;
  /** Версия, для которой уже опубликована новость в «Новости» ЦУП. */
  lastAnnouncedVersion: string;
}

/** Токен для llm-service (JWT из ЦУП, `getService('sbe-apstore').auth.getToken('llm')`) —
 *  провайдера теперь дёргает сервер своим (расшифрованным) ключом пользователя, плагин
 *  ключ провайдера больше не видит и не хранит. */
export type GetTokenFn = () => Promise<string>;

/** Центр LLM (2026-09-02: перенесён на серверный прокси, см. llm-service/AGENTS.md).
 *  Модели и промты по-прежнему передаёт потребитель — не изменилось. */
export class LLMCenter {
  private settings: LlmSettings;
  private getToken: GetTokenFn;
  private lastRequestTime = 0;
  private minRequestInterval = 2000;

  constructor(settings: LlmSettings, getToken: GetTokenFn) {
    this.settings = settings;
    this.getToken = getToken;
  }

  setSettings(settings: LlmSettings): void {
    this.settings = settings;
  }

  private get baseUrl(): string {
    return this.settings.apiBase.trim().replace(/\/+$/, '');
  }

  /** Статус — теперь всегда живой запрос на сервер (там же хранится ключ), не
   *  локальная проверка. Единственный метод SbeLlmApi, у которого изменилась
   *  сигнатура (синхронная → асинхронная) при переносе на сервер. */
  async getStatus(): Promise<{ configured: boolean; apiUrl: string }> {
    try {
      const token = await this.getToken();
      const res = await this.requestWithTimeout({
        url: `${this.baseUrl}/api/llm/settings`,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      }, 15000);
      if (res.status !== 200) return { configured: false, apiUrl: this.baseUrl };
      const data = JSON.parse(res.text) as { configured?: boolean };
      return { configured: !!data.configured, apiUrl: this.baseUrl };
    } catch (e: unknown) {
      console.warn('SBE LLM: getStatus:', errorMessage(e));
      return { configured: false, apiUrl: this.baseUrl };
    }
  }

  /** Сохраняет/заменяет ключ ТЕКУЩЕГО пользователя (email берётся сервером из JWT —
   *  подменить нельзя). apiUrl — опциональное переопределение провайдера для этого
   *  пользователя; пусто — сервер использует свой LLM_API_URL по умолчанию. */
  async setApiKey(apiKey: string, apiUrl?: string): Promise<void> {
    const token = await this.getToken();
    const res = await this.requestWithTimeout({
      url: `${this.baseUrl}/api/llm/settings`,
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, api_url: apiUrl || '' }),
    }, 15000);
    if (res.status !== 200) throw new Error(this.errorText(res) || `HTTP ${res.status}`);
  }

  async deleteApiKey(): Promise<void> {
    const token = await this.getToken();
    const res = await this.requestWithTimeout({
      url: `${this.baseUrl}/api/llm/settings`,
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }, 15000);
    if (res.status !== 200) throw new Error(this.errorText(res) || `HTTP ${res.status}`);
  }

  /** Список моделей провайдера (цены + флаг is_old_model), ключом текущего пользователя —
   *  для выпадающих списков модели в настройках плагинов-потребителей. */
  async listModels(): Promise<LlmModel[]> {
    const token = await this.getToken();
    const res = await this.requestWithTimeout({
      url: `${this.baseUrl}/api/llm/models`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, 20000);
    if (res.status !== 200) throw new Error(this.errorText(res) || `HTTP ${res.status}`);
    try {
      const data = JSON.parse(res.text) as { data?: LlmModel[] };
      return Array.isArray(data.data) ? data.data : [];
    } catch (e: unknown) {
      console.warn('SBE LLM: не JSON в ответе моделей:', errorMessage(e));
      return [];
    }
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

  /** Общая точка входа для complete/completeVision/ask — тело запроса уже в
   *  формате провайдера ({model?, messages, temperature}), llm-service пересылает
   *  его как есть, подставив ключ пользователя вместо JWT в Authorization. */
  private async chatCompletion(payload: Record<string, unknown>): Promise<string> {
    const token = await this.getToken();
    return this.retryWithBackoff(async () => {
      const response = await this.requestWithTimeout({
        url: `${this.baseUrl}/api/llm/chat/completions`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (response.status === 429) throw new Error('429: Too Many Requests');
      if (response.status !== 200) throw new Error(`HTTP ${response.status}: ${response.text}`);
      const data: LLMResponse = JSON.parse(response.text);
      return data.choices?.[0]?.message?.content || '';
    });
  }

  async complete(system: string, user: string, opts?: { model?: string; temperature?: number }): Promise<string> {
    const model = opts?.model?.trim() || '';
    const temperature = opts?.temperature ?? 0.4;
    return this.chatCompletion({
      ...(model ? { model } : {}),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature,
    });
  }

  /** Vision-запрос: передаёт изображение (data URL или http(s)-URL) вместе с текстом.
   *  Работает только с vision-моделями. */
  async completeVision(
    system: string,
    user: string,
    imageUrl: string,
    opts?: { model?: string; temperature?: number },
  ): Promise<string> {
    const model = opts?.model?.trim() || '';
    const temperature = opts?.temperature ?? 0.4;
    return this.chatCompletion({
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
    });
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

    const content = await this.chatCompletion({
      ...(model ? { model } : {}),
      messages,
      temperature: 0.3,
    });
    return content || 'Нет ответа от LLM';
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

  private errorText(res: { status: number; text: string }): string {
    if (!res.text) return '';
    try {
      const data = JSON.parse(res.text) as { error?: string };
      return data.error || '';
    } catch (e: unknown) {
      console.warn('SBE LLM: ответ сервера не JSON:', errorMessage(e));
      return '';
    }
  }

  /** requestUrl в Obsidian не имеет таймаута — без обёртки зависший сервер не даст ответа никогда. */
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
}
