import { Plugin } from 'obsidian';
import { LLMCenter, LlmSettings } from './services/llm-center';
import { LlmSettingsTab } from './ui/settings-tab';
import { publishService, unpublishService } from '../../sbe-core/src/bridge';
import { errorMessage } from '../../sbe-core/src/utils/errors';
import type { SbeLlmApi } from '../../sbe-core/src/types';

const DEFAULT_SETTINGS: LlmSettings = {
  apiUrl: 'https://ask.chadgpt.ru/api/v1/chat/completions',
  apiKeySecret: '',
};

export default class SbeLlmPlugin extends Plugin {
  settings!: LlmSettings;
  llm!: LLMCenter;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.llm = new LLMCenter(this.settings, name => this.getSecretValue(name));

    this.addSettingTab(new LlmSettingsTab(this.app, this));

    publishService<SbeLlmApi>('sbe-llm', this.buildApi(), {
      version: this.manifest.version,
      name: this.manifest.name,
    });
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

  getSecretValue(secretName: string): string | null {
    if (!secretName) return null;
    try {
      return this.app.secretStorage?.getSecret(secretName) ?? null;
    } catch (e: unknown) {
      console.error('SBE LLM: не удалось прочитать секрет:', errorMessage(e));
      return null;
    }
  }

  saveSecret(secretName: string, value: string): void {
    try {
      this.app.secretStorage?.setSecret(secretName, value);
    } catch (e: unknown) {
      console.error('SBE LLM: не удалось сохранить секрет:', errorMessage(e));
    }
  }

  private buildApi(): SbeLlmApi {
    return {
      getStatus: () => this.llm.getStatus(),
      complete: (system, user, opts) => this.llm.complete(system, user, opts),
      completeJson: (system, user, opts) => this.llm.completeJson(system, user, opts),
      ask: (question, opts) => this.llm.ask(question, opts),
    };
  }
}
