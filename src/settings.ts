import {App, PluginSettingTab, Setting} from 'obsidian';
import NoteImageGalleryPlugin from './main';

export interface Settings {
	enableCache: boolean;
	maxCacheAge: number; // 天数
	maxCacheSize: number; // MB
}

export const DEFAULT_SETTINGS: Settings = {
	enableCache: true,
	maxCacheAge: 7,
	maxCacheSize: 100
};

export class NoteImageGallerySettingTab extends PluginSettingTab {
	plugin: NoteImageGalleryPlugin;

	constructor(app: App, plugin: NoteImageGalleryPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		containerEl.createEl('h2', {text: '图片墙设置'});

		new Setting(containerEl)
			.setName('启用图片缓存')
			.setDesc('启用后，将缓存远程图片以加快加载速度')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableCache)
				.onChange(async (value) => {
					this.plugin.settings.enableCache = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('缓存有效期')
			.setDesc('图片缓存的最大有效期（天）')
			.addSlider(slider => slider
				.setLimits(1, 30, 1)
				.setValue(this.plugin.settings.maxCacheAge)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.maxCacheAge = value;
					await this.plugin.saveSettings();
					this.plugin.imageCacheService.setMaxCacheAge(value * 24 * 60 * 60 * 1000);
				}));

		new Setting(containerEl)
			.setName('最大缓存大小')
			.setDesc('图片缓存的最大大小（MB）')
			.addSlider(slider => slider
				.setLimits(10, 200, 5)
				.setValue(this.plugin.settings.maxCacheSize)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.maxCacheSize = value;
					await this.plugin.saveSettings();
					this.plugin.imageCacheService.setMaxCacheSize(value * 1024 * 1024);
				}));

		const cacheSizeInMB = (this.plugin.imageCacheService.getCacheSize() / (1024 * 1024)).toFixed(2);

		containerEl.createEl('h3', {text: '缓存状态'});
		containerEl.createEl('p', {
			text: `当前缓存大小: ${cacheSizeInMB} MB / ${this.plugin.settings.maxCacheSize} MB`
		});

		// 添加清除缓存按钮
		new Setting(containerEl)
			.setName('清除缓存')
			.setDesc('删除所有缓存的图片')
			.addButton(button => button
				.setButtonText('清除全部缓存')
				.onClick(async () => {
					this.plugin.imageCacheService.clearAllCache();
					// 刷新界面,显示更新后的缓存大小
					this.display();
				}));
	}
}
