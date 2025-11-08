import {Plugin, TFile, Notice} from 'obsidian';
import {DEFAULT_SETTINGS, Settings, NoteImageGallerySettingTab} from './settings';
import {CurrentNoteImageGalleryService} from "./service/current-note-image-gallery-service";
import {ImageCacheService} from './service/image-cache-service';
import {ImageExtractorService} from "./service/image-extractor-service";
import {log} from './utils/log-utils';
import {ObsidianImageLoader} from "./service/obsidian-image-loader";

export default class NoteImageGalleryPlugin extends Plugin {

	private imageExtractorService: ImageExtractorService;
	private currentNoteImageGalleryService: CurrentNoteImageGalleryService | null = null;
	public imageCacheService: ImageCacheService;
	public imageLoader: ObsidianImageLoader;
	public settings: Settings;

	async onload() {
		await this.loadSettings();

		log.setDebugMode(this.settings.debugMode);

		this.imageExtractorService = new ImageExtractorService();
		this.imageCacheService = new ImageCacheService(this.app);

		this.imageLoader = new ObsidianImageLoader(this.app, this);
		await this.imageCacheService.initCache();

		this.imageCacheService.setMaxCacheAge(this.settings.maxCacheAge * 24 * 60 * 60 * 1000);
		this.imageCacheService.setMaxCacheSize(this.settings.maxCacheSize * 1024 * 1024);
		this.imageCacheService.setShouldUseCacheCallback(() => this.settings.enableCache);

		this.addSettingTab(new NoteImageGallerySettingTab(this.app, this));

		this.addCommand({
			id: 'current-file',
			name: 'Current file',
			checkCallback: (checking: boolean) => {
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile && activeFile.extension === 'md') {
					if (!checking) {
						void this.openImageGalleryModal();
					}
					return true;
				}
				return false;
			}
		});

		this.addRibbonIcon('image-plus', 'Open gallery', () => {
			void this.openImageGalleryModal();
		});

		this.addCommand({
			id: 'clear-cache',
			name: 'Clear cache',
			callback: () => {
				void this.imageCacheService.clearAllCache();
				new Notice('Image cache cleared');
			}
		});
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		log.setDebugMode(this.settings.debugMode);
	}

	private async openImageGalleryModal() {
		try {
			const images = await this.getCurrentNoteImages();
			if (!images || images.length === 0) {
				new Notice('No images found in current note');
				return;
			}

			this.currentNoteImageGalleryService = new CurrentNoteImageGalleryService(this.app, this, images);
			this.currentNoteImageGalleryService.open();
		} catch (error) {
			log.error(() => 'Error opening image gallery modal:',error);
			new Notice('Error opening image gallery');
		}
	}

	private async getCurrentNoteImages(): Promise<string[]> {
		const fileContent = await this.getActiveFileContent();
		if (!fileContent) {
			return [];
		}
		return this.imageExtractorService.extractImages(fileContent);
	}

	private async getActiveFileContent(): Promise<string | null> {
		const file = this.app.workspace.getActiveFile();
		if (!(file instanceof TFile) || file.extension !== 'md') {
			return null;
		}
		return await this.app.vault.read(file);
	}

	onunload() {
		// 确保缓存索引保存到磁盘
		if (this.imageCacheService) {
			void this.imageCacheService.saveCacheIndex().then(() => {
				log.debug(() => '缓存索引已保存');
			}).catch((e) => {
				log.error(() => '保存缓存索引失败:',e);
			});
		}

		if (this.currentNoteImageGalleryService) {
			this.currentNoteImageGalleryService.close();
			this.currentNoteImageGalleryService = null;
		}
	}
}
