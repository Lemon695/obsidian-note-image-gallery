import {App, Modal, Notice, TFile} from 'obsidian';
import NoteImageGalleryPlugin from "../main";

export class CurrentNoteImageGalleryService extends Modal {
	private images: string[] = [];
	private loadedImages: number = 0;
	private totalImages: number = 0;

	constructor(app: App, plugin: NoteImageGalleryPlugin, images: string[]) {
		super(app);
		this.images = images;
		this.totalImages = images.length;
	}

	onOpen() {
		const {contentEl} = this;
		contentEl.empty();
		contentEl.addClass('current-note-image-gallery');

		// 顶部工具栏
		const toolbar = contentEl.createDiv('modal-toolbar');
		const titleEl = toolbar.createDiv('modal-title');
		titleEl.setText(`图片墙 (${this.totalImages} 张图片)`);

		// 瀑布流容器
		const container = contentEl.createDiv('image-wall-container');
		const imageWall = container.createDiv('image-wall waterfall');

		this.images.forEach(imagePath => {
			this.processImage(imagePath, imageWall);
		});
	}

	private async processImage(imagePath: string, imageWall: HTMLElement) {
		const imageDiv = imageWall.createDiv('image-item');
		try {
			const img = imageDiv.createEl('img');

			const loadingText = imageDiv.createDiv('loading-text');
			loadingText.setText('加载中...');

			// 检查是否为"微博图片链接"
			const isWeiboImage = imagePath.includes('.sinaimg.cn');
			if (isWeiboImage) {
				console.log('isWeiboImage---' + imagePath);

				try {
					const response = await fetch(imagePath, {
						headers: {
							'Referer': 'https://weibo.com/'
						}
					});

					if (!response.ok) {
						throw new Error(`HTTP error! status: ${response.status}`);
					}

					const blob = await response.blob();
					const blobUrl = URL.createObjectURL(blob);
					img.src = blobUrl;

					img.onload = () => {
						loadingText.remove();
						const ratio = img.naturalHeight / img.naturalWidth;
						imageDiv.style.gridRowEnd = `span ${Math.ceil(ratio * 20)}`;
						img.style.opacity = '1';
						this.loadedImages++;
						URL.revokeObjectURL(blobUrl);
					};
				} catch (error) {
					console.error('Error loading Weibo image:', error);
					this.handleImageError(imageDiv, '加载失败');
					this.loadedImages++;
					return;
				}
			} else {
				const loadImage = (useCors: boolean = false) => {
					if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
						if (useCors) {
							img.crossOrigin = 'anonymous';
						}
						img.src = imagePath;
					} else {
						const realPath = this.getLinkPath(imagePath);
						if (!realPath) {
							this.handleImageError(imageDiv, '找不到图片');
							return;
						}
						img.src = this.getResourcePath(realPath);
					}
				};

				img.onload = () => {
					loadingText.remove();
					const ratio = img.naturalHeight / img.naturalWidth;
					imageDiv.style.gridRowEnd = `span ${Math.ceil(ratio * 20)}`;
					img.style.opacity = '1';
					this.loadedImages++;
				};

				img.onerror = (e) => {
					if (!img.crossOrigin) {
						console.log('Retrying with CORS:', imagePath);
						loadImage(true);
					} else {
						this.handleImageError(imageDiv, '加载失败');
						this.loadedImages++;
						console.error('Failed to load image:', imagePath, e);
					}
				};

				loadImage(false);
			}

			// 点击事件处理
			imageDiv.addEventListener('click', () => {
				const currentIndex = this.images.indexOf(imagePath);
				this.createLightboxWithNavigation(currentIndex);
			});

			// 右键菜单
			imageDiv.addEventListener('contextmenu', (e) => {
				e.preventDefault();
				this.createContextMenu(e, img);
			});

		} catch (error) {
			console.error('Error processing image:', error);
			this.loadedImages++;
			this.handleImageError(imageDiv, '处理失败');
		}
	}

	private handleImageError(imageDiv: HTMLElement, message: string) {
		imageDiv.empty();
		imageDiv.addClass('error');
		imageDiv.setText(message);
	}

	private getLinkPath(link: string): string | null {
		try {
			const stripped = link.replace(/!?\[\[(.*?)]]/, '$1');
			const path = stripped.split('|')[0].trim();
			const file = this.app.metadataCache.getFirstLinkpathDest(path, '');
			return file instanceof TFile ? file.path : null;
		} catch (error) {
			console.error('Error getting link path:', error);
			return null;
		}
	}

	private getResourcePath(path: string): string {
		return this.app.vault.adapter.getResourcePath(path);
	}

	private async copyImageToClipboard(img: HTMLImageElement) {
		try {
			const canvas = document.createElement('canvas');
			canvas.width = img.naturalWidth;
			canvas.height = img.naturalHeight;

			const ctx = canvas.getContext('2d');
			if (!ctx) {
				throw new Error('Failed to get canvas context');
			}

			if (!img.complete) {
				await new Promise((resolve) => {
					img.onload = resolve;
				});
			}

			ctx.drawImage(img, 0, 0);

			try {
				const blob = await new Promise<Blob>((resolve) => {
					canvas.toBlob((b) => resolve(b!), 'image/png');
				});
				await this.writeToClipboard(blob);
			} catch (e) {
				const blob = await new Promise<Blob>((resolve) => {
					canvas.toBlob((b) => resolve(b!), 'image/jpeg', 0.95);
				});
				await this.writeToClipboard(blob);
			}

			new Notice('图片已复制到剪贴板');
		} catch (err) {
			console.error('Copy failed:', err);
			new Notice('复制失败，请重试');
		}
	}

	private async writeToClipboard(blob: Blob) {
		try {
			await navigator.clipboard.write([
				new ClipboardItem({
					[blob.type]: blob
				})
			]);
		} catch (e) {
			const data = new DataTransfer();
			data.items.add(new File([blob], 'image.png', {type: blob.type}));
			const event = new ClipboardEvent('copy', {
				clipboardData: data
			});
			document.dispatchEvent(event);
		}
	}

	private createContextMenu(e: MouseEvent, img: HTMLImageElement) {
		const menu = document.createElement('div');
		menu.addClass('image-context-menu');
		menu.style.position = 'fixed';
		menu.style.left = e.pageX + 'px';
		menu.style.top = e.pageY + 'px';

		const copyOption = menu.createDiv('menu-item');
		copyOption.setText('复制图片');
		copyOption.onclick = async () => {
			await this.copyImageToClipboard(img);
			menu.remove();
		};

		document.body.appendChild(menu);

		// 点击其他地方关闭菜单
		const closeMenu = (e: MouseEvent) => {
			if (!menu.contains(e.target as Node)) {
				menu.remove();
				document.removeEventListener('click', closeMenu);
			}
		};
		document.addEventListener('click', closeMenu);
	}

	private createLightboxWithNavigation(initialIndex: number) {
		const lightbox = document.createElement('div');
		lightbox.addClass('lightbox-overlay');

		// 创建图片容器
		const imgContainer = lightbox.createDiv('lightbox-image-container');
		const img = imgContainer.createEl('img');

		const loadingText = lightbox.createDiv('loading-text');
		loadingText.setText('加载中...');

		// 追踪当前图片索引的变量
		let currentIndex = initialIndex;

		const navigateImage = (newIndex: number) => {
			// 处理循环导航
			currentIndex = (newIndex + this.images.length) % this.images.length;

			// 显示加载提示
			loadingText.style.display = 'block';

			// 更新图片
			const newPath = this.getLinkPath(this.images[currentIndex]);
			if (newPath) {
				img.src = this.getResourcePath(newPath);
				img.onload = () => {
					loadingText.style.display = 'none';
				};
			}

			// 更新计数器
			const counter = lightbox.querySelector('.lightbox-counter');
			if (counter) {
				counter.setText(`${currentIndex + 1} / ${this.images.length}`);
			}
		};

		// 添加左右导航按钮
		if (this.images.length > 1) {
			const prevBtn = lightbox.createDiv('lightbox-nav prev');
			prevBtn.innerHTML = '&#10094;'; // 左箭头
			prevBtn.onclick = (e) => {
				e.stopPropagation();
				navigateImage(currentIndex - 1);
			};

			const nextBtn = lightbox.createDiv('lightbox-nav next');
			nextBtn.innerHTML = '&#10095;'; // 右箭头
			nextBtn.onclick = (e) => {
				e.stopPropagation();
				navigateImage(currentIndex + 1);
			};
		}

		// 显示图片计数
		const counter = lightbox.createDiv('lightbox-counter');
		counter.setText(`${currentIndex + 1} / ${this.images.length}`);

		// 添加关闭按钮
		const closeBtn = lightbox.createDiv('lightbox-close');
		closeBtn.setText('×');
		closeBtn.onclick = () => lightbox.remove();

		// 初始图片
		const initialPath = this.getLinkPath(this.images[currentIndex]);
		if (initialPath) {
			img.src = this.getResourcePath(initialPath);
			img.onload = () => loadingText.remove();
		}

		document.body.appendChild(lightbox);

		// 点击背景关闭
		lightbox.onclick = (e) => {
			if (e.target === lightbox) {
				lightbox.remove();
			}
		};

		const handleKeyDown = (e: KeyboardEvent) => {
			switch (e.key) {
				case 'ArrowLeft':
					navigateImage(currentIndex - 1);
					break;
				case 'ArrowRight':
					navigateImage(currentIndex + 1);
					break;
				case 'Escape':
					lightbox.remove();
					document.removeEventListener('keydown', handleKeyDown);
					break;
			}
		};
		document.addEventListener('keydown', handleKeyDown);
	}

}
