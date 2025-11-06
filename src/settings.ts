import {App, Notice, PluginSettingTab, Setting} from 'obsidian';
import NoteImageGalleryPlugin from './main';
import {log, LogLevel} from './utils/log-utils';

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
					if (value < 1 || value > 30 || !Number.isInteger(value)) {
						new Notice('缓存有效期必须在1-30天之间');
						return;
					}

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

		let cacheSizeInMB = "0.00";
		try {
			const cacheSize = this.plugin.imageCacheService.getCacheSize();
			if (typeof cacheSize === 'number' && !isNaN(cacheSize) && cacheSize > 0) {
				cacheSizeInMB = (cacheSize / (1024 * 1024)).toFixed(2);
			} else {
				log.debug(() => '缓存大小为0或无效');
			}
		} catch (e) {
			log.error("获取缓存大小失败:", e);
			new Notice('无法获取缓存大小，请尝试重新初始化缓存');
		}

		containerEl.createEl('h3', {text: '缓存状态'});
		const cacheStatusEl = containerEl.createEl('p', {
			text: `当前缓存大小: ${cacheSizeInMB} MB / ${this.plugin.settings.maxCacheSize} MB`
		});

		new Setting(containerEl)
			.setName('刷新缓存状态')
			.setDesc('重新计算缓存大小')
			.addButton(button => button
				.setButtonText('刷新')
				.onClick(async () => {
					// 重新初始化缓存以获取最新状态
					await this.plugin.imageCacheService.initCache();

					// 更新显示的缓存大小
					const newCacheSizeInMB = (this.plugin.imageCacheService.getCacheSize() / (1024 * 1024)).toFixed(2);
					cacheStatusEl.setText(`当前缓存大小: ${newCacheSizeInMB} MB / ${this.plugin.settings.maxCacheSize} MB`);
				}));

		// 添加清除缓存按钮
		new Setting(containerEl)
			.setName('清除缓存')
			.setDesc('删除所有缓存的图片')
			.addButton(button => button
				.setButtonText('清除全部缓存')
				.onClick(async () => {
					await this.plugin.imageCacheService.clearAllCache();
					// 刷新界面,显示更新后的缓存大小
					this.display();
				}));

		new Setting(containerEl)
			.setName('Developer')
			.setHeading()

		new Setting(containerEl)
			.setName('Debug mode')
			.setDesc('Enable debug mode to log detailed information to the console.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.debugMode)
				.onChange(async (value) => {
					this.plugin.settings.debugMode = value;

					log.setDebugMode(value);
					log.debug(() => "调试模式已" + (value ? "启用" : "禁用"));
					await this.plugin.saveSettings();
				}));
	}
}
