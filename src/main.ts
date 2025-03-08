import {Plugin, TFile, MarkdownView, Notice} from 'obsidian';
import {DEFAULT_SETTINGS, Settings, NoteImageGallerySettingTab} from './settings';
import {CurrentNoteImageGalleryService} from "./service/current-note-image-gallery-service";
import {ImageCacheService} from './service/image-cache-service';
import {ImageExtractorService} from "./service/image-extractor-service";

export default class NoteImageGalleryPlugin extends Plugin {

	private imageExtractorService: ImageExtractorService;
	private currentNoteImageGalleryService: CurrentNoteImageGalleryService | null = null;
	public imageCacheService: ImageCacheService;
	public settings: Settings;

	async onload() {
		await this.loadSettings();

		this.imageExtractorService = new ImageExtractorService();
		this.imageCacheService = new ImageCacheService(this.app);

		this.imageCacheService.setMaxCacheAge(this.settings.maxCacheAge * 24 * 60 * 60 * 1000);
		this.imageCacheService.setMaxCacheSize(this.settings.maxCacheSize * 1024 * 1024);
		this.imageCacheService.setShouldUseCacheCallback(() => this.settings.enableCache);

		this.addSettingTab(new NoteImageGallerySettingTab(this.app, this));

		this.addCommand({
			id: 'open-current-note-image-gallery',
			name: 'Open Current Note Image Gallery',
			checkCallback: (checking: boolean) => {
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile && activeFile.extension === 'md') {
					if (!checking) {
						this.openImageGalleryModal();
					}
					return true;
				}
				return false;
			}
		});

		this.addRibbonIcon('image-plus', 'Open Current Note Image Gallery', async () => {
			await this.openImageGalleryModal();
		});

		this.addCommand({
			id: 'clear-note-image-gallery-cache',
			name: 'Clear Note Image Gallery Cache',
			callback: () => {
				this.imageCacheService.clearAllCache();
				new Notice('Image gallery cache cleared');
			}
		});
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
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
			console.error('Error opening image gallery modal:', error);
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
		if (this.currentNoteImageGalleryService) {
			this.currentNoteImageGalleryService.close();
			this.currentNoteImageGalleryService = null;
		}
	}
}
