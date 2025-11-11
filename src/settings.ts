import {App, Notice, PluginSettingTab, Setting} from 'obsidian';
import NoteImageGalleryPlugin from './main';
import {log} from './utils/log-utils';
import {t} from './i18n/locale';

export interface Settings {
	enableCache: boolean;
	maxCacheAge: number; // 天数
	maxCacheSize: number; // MB

	debugMode: boolean;

	logLevel: 'debug' | 'info' | 'warn' | 'error';  // 添加日志级别设置
}

export const DEFAULT_SETTINGS: Settings = {
	enableCache: true,
	maxCacheAge: 7,
	maxCacheSize: 100,

	debugMode: false,
	logLevel: 'info',  // 默认info级别
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

		new Setting(containerEl)
			.setName(t('imageGallerySettings'))
			.setHeading();

		new Setting(containerEl)
			.setName(t('enableCache'))
			.setDesc(t('enableCacheDesc'))
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableCache)
				.onChange(async (value) => {
					this.plugin.settings.enableCache = value;
					await this.plugin.saveSettings();
				}));

		const cacheAgeSetting = new Setting(containerEl)
			.setName(t('cacheValidPeriod'))
			.setDesc(t('cacheValidPeriodDesc', {days: this.plugin.settings.maxCacheAge.toString()}))
			.addSlider(slider => slider
				.setLimits(1, 60, 1)
				.setValue(this.plugin.settings.maxCacheAge)
				.setDynamicTooltip()
				.onChange(async (value) => {
					if (value < 1 || value > 60 || !Number.isInteger(value)) {
						new Notice(t('cacheValidPeriodError'));
						return;
					}

					this.plugin.settings.maxCacheAge = value;
					await this.plugin.saveSettings();
					this.plugin.imageCacheService.setMaxCacheAge(value * 24 * 60 * 60 * 1000);

					// 更新描述显示当前值
					cacheAgeSetting.setDesc(t('cacheValidPeriodValue', {value: value.toString()}));
				}));

		let cacheSizeInMB = "0.00";
		try {
			const cacheSize = this.plugin.imageCacheService.getCacheSize();
			if (typeof cacheSize === 'number' && !isNaN(cacheSize) && cacheSize > 0) {
				cacheSizeInMB = (cacheSize / (1024 * 1024)).toFixed(2);
			} else {
				log.debug(() => t('cacheSizeZeroOrInvalid'));
			}
		} catch (e) {
			log.error(() => t('getCacheSizeFailed'),e);
			new Notice(t('unableToGetCacheSize'));
		}

		new Setting(containerEl)
			.setName(t('cacheStatus'))
			.setHeading();

		const cacheStatusEl = containerEl.createEl('p', {
			text: t('currentCacheSize', {size: cacheSizeInMB, maxSize: this.plugin.settings.maxCacheSize.toString()})
		});

		const cacheSizeSetting = new Setting(containerEl)
			.setName(t('maxCacheSize'))
			.setDesc(t('maxCacheSizeDesc', {size: this.plugin.settings.maxCacheSize.toString()}))
			.addSlider(slider => slider
				.setLimits(10, 300, 5)
				.setValue(this.plugin.settings.maxCacheSize)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.maxCacheSize = value;
					await this.plugin.saveSettings();
					this.plugin.imageCacheService.setMaxCacheSize(value * 1024 * 1024);

					// 更新描述显示当前值
					cacheSizeSetting.setDesc(t('maxCacheSizeDesc', {size: value.toString()}));

					// 更新缓存状态显示中的最大缓存大小
					const currentCacheSize = (this.plugin.imageCacheService.getCacheSize() / (1024 * 1024)).toFixed(2);
					cacheStatusEl.setText(t('currentCacheSize', {size: currentCacheSize, maxSize: value.toString()}));
				}));

		new Setting(containerEl)
			.setName(t('refreshCacheStatus'))
			.setDesc(t('recalculateCacheSize'))
			.addButton(button => button
				.setButtonText(t('refresh'))
				.onClick(() => {
					void (async () => {
						// 重新初始化缓存以获取最新状态
						await this.plugin.imageCacheService.initCache();

						// 更新显示的缓存大小
						const newCacheSizeInMB = (this.plugin.imageCacheService.getCacheSize() / (1024 * 1024)).toFixed(2);
						cacheStatusEl.setText(t('currentCacheSize', {size: newCacheSizeInMB, maxSize: this.plugin.settings.maxCacheSize.toString()}));
					})();
				}));

		// 添加清除缓存按钮
		new Setting(containerEl)
			.setName(t('clearCache'))
			.setDesc(t('clearCacheDesc'))
			.addButton(button => button
				.setButtonText(t('clearAllCache'))
				.onClick(() => {
					void (async () => {
						await this.plugin.imageCacheService.clearAllCache();
						// 刷新界面,显示更新后的缓存大小
						this.display();
					})();
				}));

		new Setting(containerEl)
			.setName(t('developer'))
			.setHeading()

		new Setting(containerEl)
			.setName(t('debugMode'))
			.setDesc(t('debugModeDesc'))
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.debugMode)
				.onChange(async (value) => {
					this.plugin.settings.debugMode = value;

					log.setDebugMode(value);
					log.debug(() => t('debugModeStatus', {status: value ? t('enabled') : t('disabled')}));
					await this.plugin.saveSettings();
				}));
	}
}
