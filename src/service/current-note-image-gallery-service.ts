import {App, Modal, Notice, TFile} from 'obsidian';
import NoteImageGalleryPlugin from "../main";
import {IncomingMessage} from 'http';

interface ImageRequest {
	controller?: AbortController;
	electronRequest?: any;
	timestamp: number;
}

interface ImageData {
	path: string;
	element: HTMLElement;
	objectUrl?: string;
	isLoading: boolean;
	hasError: boolean;
	position?: {
		top: number;
		bottom: number;
		height: number;
	};
}

export class CurrentNoteImageGalleryService extends Modal {
	private images: string[] = [];
	private loadedImages: number = 0;
	private totalImages: number = 0;
	private currentRequests: Map<string, ImageRequest> = new Map();
	private imageDataMap: Map<string, ImageData> = new Map();
	private queueImageLoad: (imagePath: string) => void = () => {
	};
	private intersectionObserver: IntersectionObserver | null = null;
	private cleanupVirtualScroll: () => void = () => {
	};

	constructor(app: App, plugin: NoteImageGalleryPlugin, images: string[]) {
		super(app);
		this.images = images;
		this.totalImages = images.length;
	}

	onOpen() {
		this.loadedImages = 0;
		this.currentRequests.clear();
		this.imageDataMap.clear();

		const {contentEl} = this;
		contentEl.empty();
		contentEl.addClass('current-note-image-gallery');

		// 顶部工具栏
		const toolbar = contentEl.createDiv('modal-toolbar');
		const titleEl = toolbar.createDiv('modal-title');
		titleEl.setText(`图片墙 (${this.totalImages} 张图片)`);

		const progressContainer = toolbar.createDiv('progress-container');
		const progressEl = progressContainer.createEl('progress', {
			attr: {
				max: this.totalImages.toString(),
				value: '0'
			}
		});

		const progressText = progressContainer.createDiv('progress-text');
		progressText.setText(`0/${this.totalImages}`);

		// 筛选和排序工具栏
		const filterToolbar = toolbar.createDiv('filter-toolbar');

		// 创建排序下拉菜单
		const sortContainer = filterToolbar.createDiv('sort-container');
		sortContainer.createSpan({text: '排序: '});
		const sortSelect = sortContainer.createEl('select', {cls: 'sort-select'});
		sortSelect.createEl('option', {text: '默认排序', value: 'default'});
		sortSelect.createEl('option', {text: '按尺寸（大到小）', value: 'size-desc'});
		sortSelect.createEl('option', {text: '按尺寸（小到大）', value: 'size-asc'});

		// 创建筛选按钮
		const filterContainer = filterToolbar.createDiv('filter-container');
		filterContainer.createSpan({text: '筛选: '});
		const allBtn = filterContainer.createEl('button', {text: '全部', cls: 'filter-btn active'});
		const localBtn = filterContainer.createEl('button', {text: '本地图片', cls: 'filter-btn'});
		const remoteBtn = filterContainer.createEl('button', {text: '网络图片', cls: 'filter-btn'});

		// 处理排序逻辑
		sortSelect.addEventListener('change', () => {
			this.sortImages(sortSelect.value);
		});

		// 处理筛选逻辑
		[allBtn, localBtn, remoteBtn].forEach(btn => {
			btn.addEventListener('click', (e) => {
				// 更新按钮状态
				[allBtn, localBtn, remoteBtn].forEach(b => b.removeClass('active'));
				btn.addClass('active');

				// 应用筛选
				const filter = btn.textContent?.toLowerCase() || 'all';
				this.filterImages(filter);
			});
		});

		// 瀑布流容器
		const container = contentEl.createDiv('image-wall-container');
		const imageWall = container.createDiv('image-wall waterfall');

		this.setupLazyLoading();
		this.setupBatchLoading();
		this.setupVirtualScroll();

		this.images.forEach(imagePath => {
			this.createImageElement(imagePath, imageWall);
		});
	}

	private setupLazyLoading() {
		this.intersectionObserver = new IntersectionObserver((entries) => {
			entries.forEach(entry => {
				if (entry.isIntersecting) {
					const imageDiv = entry.target as HTMLElement;
					const imagePath = imageDiv.getAttribute('data-path');

					if (imagePath) {
						const imageData = this.imageDataMap.get(imagePath);
						if (imageData && !imageData.isLoading && !imageData.hasError) {
							this.queueImageLoad(imagePath);
						}
					}

					// 停止观察已在视图中的图片
					this.intersectionObserver?.unobserve(entry.target);
				}
			});
		}, {
			rootMargin: '200px', // 提前200px加载图片
			threshold: 0.01
		});
	}

	private setupBatchLoading() {
		const MAX_CONCURRENT_LOADS = 5;
		const MAX_RETRIES = 3;
		const loadQueue: Array<{ path: string, retries: number }> = [];
		let activeLoads = 0;
		let isProcessingQueue = false;

		const processQueue = async () => {
			if (isProcessingQueue || loadQueue.length === 0 || activeLoads >= MAX_CONCURRENT_LOADS) return;

			isProcessingQueue = true;

			while (loadQueue.length > 0 && activeLoads < MAX_CONCURRENT_LOADS) {
				const item = loadQueue.shift();
				if (!item) continue;

				const {path, retries} = item;
				const imageData = this.imageDataMap.get(path);

				if (!imageData || imageData.isLoading || imageData.hasError) continue;

				activeLoads++;

				try {
					await this.loadImage(path, imageData.element);
				} catch (error) {
					console.error(`加载图片 ${path} 时出错:`, error);

					// 重试逻辑
					if (retries < MAX_RETRIES) {
						console.log(`将 ${path} 排队重试 ${retries + 1}/${MAX_RETRIES}`);
						loadQueue.push({path, retries: retries + 1});
					}
				} finally {
					activeLoads--;
				}
			}

			isProcessingQueue = false;

			// 如果我们仍有项目和容量，继续处理
			if (loadQueue.length > 0 && activeLoads < MAX_CONCURRENT_LOADS) {
				setTimeout(processQueue, 50);
			}
		};

		this.queueImageLoad = (imagePath: string) => {
			if (!loadQueue.some(item => item.path === imagePath)) {
				loadQueue.push({path: imagePath, retries: 0});
				setTimeout(processQueue, 0);
			}
		};
	}

	private setupVirtualScroll() {
		const container = this.contentEl.querySelector('.image-wall-container');
		if (!container) return;

		// 视口可见区域的前后缓冲区大小（像素）
		const BUFFER_SIZE = 1000;

		// 记录各图片元素的位置信息
		const updateElementPositions = () => {
			this.imageDataMap.forEach((data) => {
				const el = data.element;
				if (el) {
					const rect = el.getBoundingClientRect();
					data.position = {
						top: rect.top + container.scrollTop,
						bottom: rect.bottom + container.scrollTop,
						height: rect.height
					};
				}
			});
		};

		// 初始化位置信息
		setTimeout(updateElementPositions, 500);

		// 滚动时仅渲染可见区域附近的元素
		const scrollHandler = () => {
			const scrollTop = container.scrollTop;
			const viewportHeight = container.clientHeight;
			const viewportTop = scrollTop - BUFFER_SIZE;
			const viewportBottom = scrollTop + viewportHeight + BUFFER_SIZE;

			// 获取当前激活的筛选按钮
			const activeFilterBtn = this.contentEl.querySelector('.filter-btn.active');
			const currentFilter = activeFilterBtn ? activeFilterBtn.textContent?.toLowerCase() : 'all';

			this.imageDataMap.forEach((data) => {
				// 如果还没有位置信息，跳过
				if (!data.position) return;

				// 检查是否应该基于筛选条件显示
				const imagePath = data.path;
				const isRemote = imagePath.startsWith('http://') || imagePath.startsWith('https://');
				const matchesFilter =
					currentFilter === '全部' || currentFilter === 'all' ||
					(currentFilter === '本地图片' || currentFilter === 'local') && !isRemote ||
					(currentFilter === '网络图片' || currentFilter === 'remote') && isRemote;

				// 检查是否在可视区域内
				const isVisible = data.position.bottom >= viewportTop &&
					data.position.top <= viewportBottom;

				if (isVisible && matchesFilter) {
					// 在可视区域内且符合筛选条件
					if (!data.isLoading && !data.objectUrl && !data.hasError) {
						this.queueImageLoad(data.path);
					}
					data.element.style.display = ''; // 显示元素
					data.element.style.visibility = '';
				} else if (!matchesFilter) {
					// 不符合筛选条件
					data.element.style.display = 'none';
				} else {
					// 符合筛选条件但不在可视区域内
					data.element.style.visibility = 'hidden';
					data.element.style.display = ''; // 保留在DOM中但不可见
				}
			});
		};

		// 添加事件监听器
		container.addEventListener('scroll', scrollHandler);
		window.addEventListener('resize', updateElementPositions);

		// 保存清理函数到实例，以便在onClose中调用
		this.cleanupVirtualScroll = () => {
			container.removeEventListener('scroll', scrollHandler);
			window.removeEventListener('resize', updateElementPositions);
		};
	}

	private sortImages(sortType: string) {
		const container = this.contentEl.querySelector('.image-wall');
		if (!container) return;

		// 获取所有图片元素
		const items = Array.from(container.querySelectorAll('.image-item'));

		// 根据排序类型排序
		if (sortType === 'size-desc' || sortType === 'size-asc') {
			items.sort((a, b) => {
				const aSize = this.getImageSize(a);
				const bSize = this.getImageSize(b);
				return sortType === 'size-desc' ? bSize - aSize : aSize - bSize;
			});
		}

		// 重新排列DOM
		items.forEach(item => container.appendChild(item));
	}

	private getImageSize(element: Element): number {
		const img = element.querySelector('img');
		if (!img) return 0;

		const width = (img as HTMLImageElement).naturalWidth || 0;
		const height = (img as HTMLImageElement).naturalHeight || 0;
		return width * height;
	}

	private filterImages(filterType: string) {
		this.imageDataMap.forEach((data) => {
			const imagePath = data.path;
			const isRemote = imagePath.startsWith('http://') || imagePath.startsWith('https://');

			if (filterType === 'all' || filterType === '全部') {
				data.element.style.display = '';
				// 重置visibility属性，让虚拟滚动控制
				data.element.style.visibility = '';
			} else if ((filterType === '本地图片' || filterType === 'local') && !isRemote) {
				data.element.style.display = '';
				data.element.style.visibility = '';
			} else if ((filterType === '网络图片' || filterType === 'remote') && isRemote) {
				data.element.style.display = '';
				data.element.style.visibility = '';
			} else {
				data.element.style.display = 'none';
			}
		});

		// 应用筛选后重新触发一次滚动处理，确保可见性正确
		const container = this.contentEl.querySelector('.image-wall-container');
		if (container) {
			container.dispatchEvent(new Event('scroll'));
		}
	}

	private createImageElement(imagePath: string, imageWall: HTMLElement) {
		const imageDiv = imageWall.createDiv('image-item');
		imageDiv.setAttribute('data-path', imagePath);

		// 存储图片元素引用
		this.imageDataMap.set(imagePath, {
			path: imagePath,
			element: imageDiv,
			isLoading: false,
			hasError: false
		});

		// 添加占位符
		const placeholder = imageDiv.createDiv('image-placeholder');

		// 监听此元素以实现懒加载
		this.intersectionObserver?.observe(imageDiv);

		// 添加点击事件用于查看大图
		imageDiv.addEventListener('click', () => {
			const currentIndex = this.images.indexOf(imagePath);
			this.createLightboxWithNavigation(currentIndex);
		});

		// 添加右键菜单
		imageDiv.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			const img = imageDiv.querySelector('img');
			if (img) {
				this.createContextMenu(e, img as HTMLImageElement);
			}
		});
	}

	private async loadImage(imagePath: string, imageDiv: HTMLElement) {
		const imageData = this.imageDataMap.get(imagePath);
		if (!imageData || imageData.isLoading) return;

		imageData.isLoading = true;

		try {
			// 创建图片元素（如果尚不存在）
			let img = imageDiv.querySelector('img') as HTMLImageElement;
			if (!img) {
				img = imageDiv.createEl('img');
			}

			const loadingText = imageDiv.querySelector('.loading-text') || imageDiv.createDiv('loading-text');
			loadingText.setText('加载中...');

			// 检查是否为微博图片
			const isWeiboImage = imagePath.includes('.sinaimg.cn');

			if (isWeiboImage) {
				await this.loadWeiboImage(imagePath, img, imageDiv, loadingText as HTMLElement);
			} else {
				await this.loadRegularImage(imagePath, img, imageDiv, loadingText as HTMLElement);
			}
		} catch (error) {
			console.error('Error processing image:', error);
			this.loadedImages++;
			this.updateProgressBar();
			this.handleImageError(imageDiv, '处理失败');

			if (imageData) {
				imageData.hasError = true;
				imageData.isLoading = false;
			}
		}
	}

	private async loadRegularImage(
		imagePath: string,
		img: HTMLImageElement,
		imageDiv: HTMLElement,
		loadingText: HTMLElement
	): Promise<void> {
		return new Promise((resolve, reject) => {
			// 为此请求创建新的 AbortController
			const controller = new AbortController();
			const requestId = Date.now().toString();

			// 保存请求数据
			this.currentRequests.set(requestId, {
				controller,
				timestamp: Date.now()
			});

			imageDiv.setAttribute('data-request-id', requestId);

			// 设置图片加载处理程序
			img.onload = () => {
				loadingText.remove();

				// 移除占位符
				const placeholder = imageDiv.querySelector('.image-placeholder');
				if (placeholder) {
					placeholder.remove();
				}

				const ratio = img.naturalHeight / img.naturalWidth;

				const baseHeight = 10;
				const heightSpan = Math.min(Math.ceil(ratio * baseHeight), 30);

				imageDiv.style.gridRowEnd = `span ${heightSpan}`;
				img.style.opacity = '1';
				this.loadedImages++;
				this.updateProgressBar();
				this.currentRequests.delete(requestId);

				// 更新图片数据
				const imageData = this.imageDataMap.get(imagePath);
				if (imageData) {
					imageData.isLoading = false;
				}

				resolve();
			};

			img.onerror = (e) => {
				console.error('图片加载错误:', imagePath);

				// 如果尚未尝试，先使用 CORS
				if (!img.crossOrigin && (imagePath.startsWith('http://') || imagePath.startsWith('https://'))) {
					console.log('使用 CORS 重试:', imagePath);
					img.crossOrigin = 'anonymous';
					img.src = imagePath;
					return; // 提前退出以给重试一个机会
				}

				// 如果到达这里，重试失败或不适用
				this.handleImageError(imageDiv, '加载失败');
				this.loadedImages++;
				this.updateProgressBar();

				// 更新图片数据
				const imageData = this.imageDataMap.get(imagePath);
				if (imageData) {
					imageData.isLoading = false;
					imageData.hasError = true;
				}

				this.currentRequests.delete(requestId);
				reject(e);
			}

			// 设置 src 开始加载
			if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
				img.src = imagePath;
			} else {
				const realPath = this.getLinkPath(imagePath);
				if (!realPath) {
					this.handleImageError(imageDiv, '找不到图片');
					this.loadedImages++;
					this.updateProgressBar();

					// 更新图片数据
					const imageData = this.imageDataMap.get(imagePath);
					if (imageData) {
						imageData.isLoading = false;
						imageData.hasError = true;
					}

					this.currentRequests.delete(requestId);
					reject(new Error('Image path not found'));
					return;
				}
				img.src = this.getResourcePath(realPath);
			}
		});
	}

	private async loadWeiboImage(
		imagePath: string,
		img: HTMLImageElement,
		imageDiv: HTMLElement,
		loadingText: HTMLElement,
		retryCount: number = 0
	): Promise<void> {
		const MAX_RETRIES = 3;

		return new Promise<void>(async (resolve, reject) => {
			try {
				const {net} = require('electron').remote;

				// 创建新请求前检查并清理旧请求
				const existingRequestId = imageDiv.getAttribute('data-request-id');
				if (existingRequestId) {
					const oldRequest = this.currentRequests.get(existingRequestId);
					if (oldRequest) {
						if (oldRequest.electronRequest) {
							try {
								oldRequest.electronRequest.abort();
							} catch (e) {
								console.error('无法中止Electron请求:', e);
							}
						} else if (oldRequest.controller) {
							oldRequest.controller.abort();
						}
						this.currentRequests.delete(existingRequestId);
					}
				}

				const request = net.request({
					url: imagePath,
					headers: {
						'Referer': 'https://weibo.com/',
						'Cache-Control': 'no-cache',
					}
				});

				// 生成并存储新的请求ID
				const requestId = Date.now().toString();
				imageDiv.setAttribute('data-request-id', requestId);
				this.currentRequests.set(requestId, {
					electronRequest: request,
					timestamp: Date.now()
				});

				const imageData: Buffer[] = [];

				request.on('response', (response: IncomingMessage) => {
					if (response.statusCode !== 200) {
						throw new Error(`HTTP Error: ${response.statusCode}`);
					}

					response.on('data', (chunk: Buffer) => {
						imageData.push(chunk);
					});

					response.on('end', () => {
						try {
							const buffer = Buffer.concat(imageData);
							const blob = new Blob([buffer]);

							// 清理旧的 objectURL
							const oldObjectUrl = imageDiv.getAttribute('data-object-url');
							if (oldObjectUrl) {
								URL.revokeObjectURL(oldObjectUrl);
							}

							const objectUrl = URL.createObjectURL(blob);
							imageDiv.setAttribute('data-object-url', objectUrl);

							img.onload = () => {
								loadingText.remove();

								// 移除占位符
								const placeholder = imageDiv.querySelector('.image-placeholder');
								if (placeholder) {
									placeholder.remove();
								}

								const ratio = img.naturalHeight / img.naturalWidth;

								const baseHeight = 10;
								const heightSpan = Math.min(Math.ceil(ratio * baseHeight), 30);

								imageDiv.style.gridRowEnd = `span ${heightSpan}`;
								img.style.opacity = '1';
								this.loadedImages++;
								this.updateProgressBar();
								this.currentRequests.delete(requestId);
								resolve();
							};

							img.onerror = async () => {
								URL.revokeObjectURL(objectUrl);
								if (retryCount < MAX_RETRIES) {
									console.log(`Retrying image load (${retryCount + 1}/${MAX_RETRIES}): ${imagePath}`);
									await this.loadWeiboImage(imagePath, img, imageDiv, loadingText, retryCount + 1);
									resolve();
								} else {
									this.handleImageError(imageDiv, '加载失败');
									this.loadedImages++;
									reject(new Error('Max retries reached'));
								}
							};

							img.src = objectUrl;
						} catch (error) {
							this.handleError(error, imageDiv, requestId, retryCount);
						}
					});
				});

				request.on('error', (error: Error) => {
					this.handleError(error, imageDiv, requestId, retryCount);
				});

				request.end();
			} catch (error) {
				const currentRequestId = imageDiv.getAttribute('data-request-id');
				this.handleError(error, imageDiv, currentRequestId || undefined, retryCount);
			}
		});
	}

	private handleError(error: Error, imageDiv: HTMLElement, requestId: string | undefined, retryCount: number) {
		const MAX_RETRIES = 3;

		console.error('Error loading Weibo image:', error);
		if (requestId) {
			this.currentRequests.delete(requestId);
		}

		if (retryCount < MAX_RETRIES) {
			console.log(`Retrying after error (${retryCount + 1}/${MAX_RETRIES})`);
			setTimeout(() => {
				const img = imageDiv.querySelector('img');
				const loadingText = imageDiv.querySelector('.loading-text');
				if (img && loadingText) {
					const imgSrc = (img as HTMLImageElement).src;
					this.loadWeiboImage(imgSrc, img as HTMLImageElement, imageDiv, loadingText as HTMLElement, retryCount + 1);
				}
			}, 1000 * (retryCount + 1));
		} else {
			this.handleImageError(imageDiv, '加载失败');
			this.loadedImages++;
		}
	}

	private updateProgressBar() {
		const progressEl = this.contentEl.querySelector('progress');
		const progressText = this.contentEl.querySelector('.progress-text');
		if (progressEl) {
			progressEl.setAttribute('value', this.loadedImages.toString());

			// 计算百分比并更新文本
			const percentage = Math.round((this.loadedImages / this.totalImages) * 100);
			if (progressText) {
				progressText.setText(`${this.loadedImages}/${this.totalImages}`);
			}

			// 当加载完成时添加完成动画
			if (this.loadedImages >= this.totalImages) {
				// 添加一个小延迟，让用户看到进度条完成
				setTimeout(() => {
					const container = this.contentEl.querySelector('.progress-container');
					if (container) {
						container.addClass('complete');
					}
				}, 800); // 较短的延迟，保持用户体验流畅
			}
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

	private downloadImage(img: HTMLImageElement) {
		try {
			const a = document.createElement('a');

			// 从图片 src 获取文件名
			const src = img.src;
			let filename = 'image.png';

			if (src.startsWith('blob:')) {
				// 对于 blob URL，使用通用名称
				filename = 'obsidian-image.png';
			} else {
				// 尝试从 URL 提取文件名
				const urlParts = src.split('/');
				if (urlParts.length > 0) {
					const potentialName = urlParts[urlParts.length - 1].split('?')[0];
					if (potentialName && potentialName.includes('.')) {
						filename = potentialName;
					}
				}
			}

			a.href = img.src;
			a.download = filename;
			a.click();

			new Notice('正在下载图片');
		} catch (error) {
			console.error('下载失败:', error);
			new Notice('图片下载失败');
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

		const downloadOption = menu.createDiv('menu-item');
		downloadOption.setText('下载图片');
		downloadOption.onclick = () => {
			this.downloadImage(img);
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
		let isZoomed = false;
		let initialScale = 1;

		// 添加缩放功能
		const zoomImage = (scale: number) => {
			if (!isZoomed && scale > 1) {
				img.style.transform = `scale(${scale})`;
				isZoomed = true;
				initialScale = scale;
			} else if (isZoomed && scale === 1) {
				img.style.transform = 'scale(1)';
				isZoomed = false;
			} else if (isZoomed) {
				// 已缩放状态下的额外缩放
				img.style.transform = `scale(${initialScale * scale})`;
			}
		};

		// 添加鼠标滚轮缩放处理
		imgContainer.onwheel = (e) => {
			e.preventDefault();
			if (e.deltaY < 0) {
				// 放大
				zoomImage(isZoomed ? 1.2 : 1.5);
			} else {
				// 缩小
				zoomImage(1);
			}
		};

		// 添加双击缩放
		imgContainer.ondblclick = () => {
			zoomImage(isZoomed ? 1 : 2);
		};

		const navigateImage = (newIndex: number) => {
			// 处理循环导航
			currentIndex = (newIndex + this.images.length) % this.images.length;

			// 显示加载提示
			loadingText.style.display = 'block';

			// 重置缩放状态
			isZoomed = false;
			img.style.transform = 'scale(1)';

			// 更新图片
			const imagePath = this.images[currentIndex];
			const imageData = this.imageDataMap.get(imagePath);

			if (imageData && imageData.objectUrl) {
				// 如果有缓存的 object URL 则使用它
				img.src = imageData.objectUrl;
			} else if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
				// 使用直接 URL
				img.src = imagePath;
			} else {
				const newPath = this.getLinkPath(this.images[currentIndex]);
				if (newPath) {
					img.src = this.getResourcePath(newPath);
				}
			}

			img.onload = () => {
				loadingText.style.display = 'none';
			};

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

		// 添加缩放控制按钮
		const controls = lightbox.createDiv('lightbox-controls');

		const zoomOutBtn = controls.createDiv('zoom-button zoom-out');
		zoomOutBtn.innerHTML = '−';
		zoomOutBtn.onclick = (e) => {
			e.stopPropagation();
			zoomImage(1); // 重置缩放
		};

		const zoomInBtn = controls.createDiv('zoom-button zoom-in');
		zoomInBtn.innerHTML = '+';
		zoomInBtn.onclick = (e) => {
			e.stopPropagation();
			zoomImage(isZoomed ? 1.5 : 2);
		};

		// 添加关闭按钮
		const closeBtn = lightbox.createDiv('lightbox-close');
		closeBtn.setText('×');
		closeBtn.onclick = () => lightbox.remove();

		// 初始图片
		navigateImage(currentIndex);

		document.body.appendChild(lightbox);

		// 点击背景关闭
		lightbox.onclick = (e) => {
			if (e.target === lightbox) {
				lightbox.remove();
			}
		};

		// 添加键盘导航
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
				case '+':
				case '=':
					zoomImage(isZoomed ? 1.5 : 2);
					break;
				case '-':
					zoomImage(1);
					break;
			}
		};
		document.addEventListener('keydown', handleKeyDown);

		// 添加清理函数
		lightbox.addEventListener('remove', () => {
			document.removeEventListener('keydown', handleKeyDown);
		});
	}

	onClose() {
		this.currentRequests.forEach((request) => {
			try {
				if (request.controller) {
					request.controller.abort();
				} else if (request.electronRequest) {
					request.electronRequest.abort();
				}
			} catch (e) {
				console.error('中止请求时出错:', e);
			}
		});
		this.currentRequests.clear();

		// 释放对象 URL
		this.imageDataMap.forEach((data) => {
			if (data.objectUrl) {
				try {
					URL.revokeObjectURL(data.objectUrl);
				} catch (e) {
					console.error('撤销对象 URL 时出错:', e);
				}
			}
		});
		this.imageDataMap.clear();

		// 清理观察者和事件监听器
		if (this.intersectionObserver) {
			this.intersectionObserver.disconnect();
			this.intersectionObserver = null;
		}

		// 清理虚拟滚动相关事件监听器
		this.cleanupVirtualScroll();

		// 重置状态
		this.loadedImages = 0;
		this.imageDataMap.clear();

		this.contentEl.empty();
	}

}
