import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type SbeLlmPlugin from '../main';

export class LlmSettingsTab extends PluginSettingTab {
  private plugin: SbeLlmPlugin;

  constructor(app: App, plugin: SbeLlmPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'SBE LLM Center' });
    containerEl.createEl('p', {
      cls: 'tn-muted',
      text: 'Центральный LLM-сервис для всех плагинов системы SBE. Плагины-потребители (например, «Мастер презентаций») передают модель и промты самостоятельно.',
    });

    new Setting(containerEl)
      .setName('URL API')
      .setDesc('Адрес OpenAI-совместимого чат-эндпоинта.')
      .addText(text => text
        .setPlaceholder('https://ask.chadgpt.ru/api/v1/chat/completions')
        .setValue(this.plugin.settings.apiUrl)
        .onChange(async (value) => {
          this.plugin.settings.apiUrl = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('API-ключ')
      .setDesc('Секрет хранится защищённо (secretStorage Obsidian). Пустое поле — без изменений.')
      .addText(text => {
        text.inputEl.type = 'password';
        text.setPlaceholder('sk-...');
        text
          .onChange((value) => {
            if (!value) return;
            // Стабильный ID: перезаписываем один и тот же секрет, а не плодим sbe-llm-<ts> каждый раз.
            const secretName = 'sbe-llm-apikey';
            this.plugin.saveSecret(secretName, value);
            this.plugin.settings.apiKeySecret = secretName;
            void this.plugin.saveSettings();
          });
        return text;
      });

    new Setting(containerEl)
      .setName('Состояние')
      .setDesc('Проверка конфигурации сервиса.')
      .addButton(btn => btn
        .setButtonText('Проверить')
        .onClick(() => {
          const status = this.plugin.llm.getStatus();
          if (status.configured) {
            new Notice(`SBE LLM: настроен (${status.apiUrl})`);
          } else {
            new Notice('SBE LLM: API-ключ не задан');
          }
        }));
  }
}
