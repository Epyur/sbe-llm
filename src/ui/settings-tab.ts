import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import { errorMessage } from '../../../sbe-core/src/utils/errors';
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
      text: 'Центральный LLM-сервис для всех плагинов системы SBE. Плагины-потребители (например, «Мастер презентаций») передают модель и промты самостоятельно. '
        + 'Ключ провайдера хранится на сервере, привязан к вашей почте — один раз настроенный здесь ключ автоматически доступен и в веб-версии.',
    });

    new Setting(containerEl)
      .setName('Адрес сервера')
      .setDesc('Адрес стека SBE (не адрес провайдера ИИ).')
      .addText(text => text
        .setPlaceholder('https://epyur.fvds.ru')
        .setValue(this.plugin.settings.apiBase)
        .onChange(async (value) => {
          this.plugin.settings.apiBase = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('API-ключ провайдера')
      .setDesc('Ваш личный ключ (например, chadgpt.ru) — шифруется и хранится на сервере, привязан к вашей почте. Пустое поле при сохранении игнорируется.')
      .addText(text => {
        text.inputEl.type = 'password';
        text.setPlaceholder('chad-...');
        return text;
      })
      .addButton(btn => btn
        .setButtonText('Сохранить')
        .onClick(async () => {
          const input = containerEl.querySelector('input[type="password"]') as HTMLInputElement | null;
          const value = input?.value?.trim();
          if (!value) {
            new Notice('Введите ключ');
            return;
          }
          btn.setDisabled(true);
          try {
            await this.plugin.llm.setApiKey(value);
            new Notice('Ключ сохранён на сервере');
            if (input) input.value = '';
          } catch (e: unknown) {
            new Notice(`Ошибка: ${errorMessage(e)}`);
          } finally {
            btn.setDisabled(false);
          }
        }));

    new Setting(containerEl)
      .setName('Состояние')
      .setDesc('Проверка конфигурации на сервере.')
      .addButton(btn => btn
        .setButtonText('Проверить')
        .onClick(async () => {
          btn.setDisabled(true);
          try {
            const status = await this.plugin.llm.getStatus();
            new Notice(status.configured ? 'SBE LLM: ключ настроен' : 'SBE LLM: ключ не задан');
          } catch (e: unknown) {
            new Notice(`Ошибка: ${errorMessage(e)}`);
          } finally {
            btn.setDisabled(false);
          }
        }))
      .addButton(btn => btn
        .setButtonText('Удалить ключ')
        .setWarning()
        .onClick(async () => {
          btn.setDisabled(true);
          try {
            await this.plugin.llm.deleteApiKey();
            new Notice('Ключ удалён');
          } catch (e: unknown) {
            new Notice(`Ошибка: ${errorMessage(e)}`);
          } finally {
            btn.setDisabled(false);
          }
        }));
  }
}
