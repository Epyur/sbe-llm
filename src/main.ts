import { Plugin } from 'obsidian';
import { LLMCenter, LlmSettings } from './services/llm-center';
import { LlmSettingsTab } from './ui/settings-tab';
import { publishService, unpublishService, getService } from '../../sbe-core/src/bridge';
import type { SbeLlmApi } from '../../sbe-core/src/types';
import { errorMessage } from '../../sbe-core/src/utils/errors';

const DEFAULT_SETTINGS: LlmSettings = {
  apiBase: 'https://epyur.fvds.ru',
  lastAnnouncedVersion: '',
};

export default class SbeLlmPlugin extends Plugin {
  settings!: LlmSettings;
  llm!: LLMCenter;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.llm = new LLMCenter(this.settings, () => this.getToken());

    this.addSettingTab(new LlmSettingsTab(this.app, this));

    publishService<SbeLlmApi>('sbe-llm', this.buildApi(), {
      version: this.manifest.version,
      name: this.manifest.name,
    });

    // Новость об обновлении — один раз на версию (канал «Новости» ЦУП).
    void this.announceOnce();
  }

  onunload(): void {
    unpublishService('sbe-llm');
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData() as Partial<LlmSettings>) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.llm.setSettings(this.settings);
  }

  /** JWT для llm-service (тот же паттерн, что у остальных SBE-плагинов) — ключ
   *  провайдера теперь только на сервере, плагин его не хранит и не видит. */
  private async getToken(): Promise<string> {
    const apstore = await getService('sbe-apstore');
    return apstore.auth.getToken('llm');
  }

  private buildApi(): SbeLlmApi {
    return {
      getStatus: () => this.llm.getStatus(),
      complete: (system, user, opts) => this.llm.complete(system, user, opts),
      completeVision: (system, user, imageUrl, opts) => this.llm.completeVision(system, user, imageUrl, opts),
      completeJson: (system, user, opts) => this.llm.completeJson(system, user, opts),
      ask: (question, opts) => this.llm.ask(question, opts),
    };
  }

  /** Публикация новости в канал «Новости» ЦУП — один раз на версию. */
  private async announceOnce(): Promise<void> {
    if (this.settings.lastAnnouncedVersion === this.manifest.version) return;
    try {
      const apstore = await getService('sbe-apstore');
      await apstore.announceUpdate({
        appId: this.manifest.id,
        appName: this.manifest.name,
        version: this.manifest.version,
        summary: 'В «SBE LLM Center» ключ провайдера ИИ теперь хранится не на компьютере, а на сервере — зашифрован и привязан к вашей почте. Введите его один раз в настройках плагина или веб-версии — и он автоматически заработает везде: в любом плагине и в веб-портале.',
      });
      this.settings.lastAnnouncedVersion = this.manifest.version;
      await this.saveSettings();
    } catch (e: unknown) {
      console.warn('SBE LLM: не удалось опубликовать новость об обновлении:', errorMessage(e));
    }
  }
}
