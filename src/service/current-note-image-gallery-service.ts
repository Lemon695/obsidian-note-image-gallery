import {App, Modal, Notice, TFile, debounce, requestUrl} from 'obsidian';
import NoteImageGalleryPlugin from "../main";
import {log} from "../utils/log-utils";
import {RetryHandler} from "../utils/retry-handler";
import {ResourceManager} from "../utils/resource-manager";
import {t} from "../i18n/locale";

// 定义Electron请求接口（用于向后兼容）
interface ElectronRequest {
	abort(): void;
}

interface ImageRequest {
	controller?: AbortController;
	electronRequest?: ElectronRequest;
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

interface QueueItem {
	path: string;
	retries: number;
	priority: 'high' | 'normal' | 'low';  // 优先级
	timestamp: number;  // 入队时间
}

export class CurrentNoteImageGalleryService extends Modal {
	private images: string[] = [];
	private loadedImages = 0;
	private totalImages = 0;
	private currentRequests: Map<string, ImageRequest> = new Map();
	private imageDataMap: Map<string, ImageData> = new Map();
	private queueImageLoad: (imagePath: string, isVisible?: boolean) => void = () => {
	};
	private intersectionObserver: IntersectionObserver | null = null;
	private cleanupVirtualScroll: () => void = () => {
	};
	private plugin: NoteImageGalleryPlugin;
	private cleanupQueueMonitor: () => void = () => {
	};
	private resourceManager: ResourceManager;
	private retryHandler = new RetryHandler(3);
	private currentSortType = 'default';  // 保存当前的排序类型
	private debouncedSort = debounce((sortType: string) => {
		log.debug(() => `Debounce ended, applying auto sort, type: ${sortType}`);
		this.sortImages(sortType);
	}, 1000);
	private isClosed = false;  // 标记 Modal 是否已关闭

	constructor(app: App, plugin: NoteImageGalleryPlugin, images: string[]) {
		super(app);
		this.images = images;
		this.totalImages = images.length;
		this.plugin = plugin;
		this.resourceManager = new ResourceManager();
	}

	onOpen() {
		this.loadedImages = 0;
		this.currentRequests.clear();
		this.imageDataMap.clear();

		const {contentEl} = this;
		contentEl.empty();
		contentEl.addClass('nig-gallery');

		const toolbar = contentEl.createDiv('nig-toolbar');
		const titleEl = toolbar.createDiv('nig-title');
		titleEl.setText(t('imageGalleryTitle', {count: this.totalImages.toString()}));

		const progressContainer = toolbar.createDiv('nig-progress-container');
		progressContainer.createEl('progress', {
			attr: {
				max: this.totalImages.toString(),
				value: '0'
			}
		});

		const progressText = progressContainer.createDiv('nig-progress-text');
		progressText.setText(`0/${this.totalImages}`);

		const filterToolbar = toolbar.createDiv('nig-filter-toolbar');

		const sortContainer = filterToolbar.createDiv('nig-sort-container');
		sortContainer.createSpan({text: t('sort')});
		const sortSelect = sortContainer.createEl('select', {cls: 'nig-sort-select'});
		sortSelect.createEl('option', {text: t('defaultSort'), value: 'default'});
		sortSelect.createEl('option', {text: t('sortBySizeDesc'), value: 'size-desc'});
		sortSelect.createEl('option', {text: t('sortBySizeAsc'), value: 'size-asc'});

		const filterContainer = filterToolbar.createDiv('nig-filter-container');
		filterContainer.createSpan({text: t('filter')});
		const allBtn = filterContainer.createEl('button', {text: t('all'), cls: 'nig-filter-btn nig-active'});
		const localBtn = filterContainer.createEl('button', {text: t('localImages'), cls: 'nig-filter-btn'});
		const remoteBtn = filterContainer.createEl('button', {text: t('networkImages'), cls: 'nig-filter-btn'});
		allBtn.dataset.filter = 'all';
		localBtn.dataset.filter = 'local';
		remoteBtn.dataset.filter = 'remote';

		sortSelect.addEventListener('change', () => {
			this.sortImages(sortSelect.value);
		});

		[allBtn, localBtn, remoteBtn].forEach(btn => {
			btn.addEventListener('click', (e) => {
				[allBtn, localBtn, remoteBtn].forEach(b => b.removeClass('nig-active'));
				btn.addClass('nig-active');

				const filter = btn.dataset.filter ?? 'all';
				this.filterImages(filter);
			});
		});

		// 瀑布流容器
		const container = contentEl.createDiv('nig-image-wall-container');
		const imageWall = container.createDiv('nig-image-wall nig-waterfall');

		this.setupLazyLoading();
		this.setupBatchLoading();
		this.setupVirtualScroll();

		// 分批渲染图片元素，避免阻塞主线程
		void this.renderImagesInBatches(imageWall);
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
			rootMargin: '200px',
			threshold: 0.01
		});
	}

	private setupBatchLoading() {
		const MAX_CONCURRENT_LOADS = 5;
		const loadQueue: QueueItem[] = [];
		let activeLoads = 0;
		let isProcessingQueue = false;

		// 队列排序函数
		const sortQueue = () => {
			const priorityValue = {high: 1, normal: 2, low: 3};
			loadQueue.sort((a, b) => {
				// 先按优先级
				const priorityDiff = priorityValue[a.priority] - priorityValue[b.priority];
				if (priorityDiff !== 0) return priorityDiff;
				// 同优先级按时间(FIFO)
				return a.timestamp - b.timestamp;
			});
		};

		const processQueue = () => {
			if (isProcessingQueue || loadQueue.length === 0 || activeLoads >= MAX_CONCURRENT_LOADS) return;

			isProcessingQueue = true;

			try {
				sortQueue();  // 每次处理前排序

				while (loadQueue.length > 0 && activeLoads < MAX_CONCURRENT_LOADS) {
					const item = loadQueue.shift();
					if (!item) continue;

					const {path} = item;
					const imageData = this.imageDataMap.get(path);

					if (!imageData || imageData.isLoading || imageData.hasError) continue;

					activeLoads++;
					imageData.isLoading = true;

					// 是否为网络图片，以及是否为微博图片
					const isNetworkImage = path.startsWith('http');
					const isWeiboImage = path.includes('.sinaimg.cn');

					log.debug(() => `Processing image: ${path}, network: ${isNetworkImage}, weibo: ${isWeiboImage}, active loads: ${activeLoads}`);

					// 异步执行加载操作，确保 activeLoads 计数器正确管理
					void (async () => {
						try {
							await this.retryHandler.execute(
								async () => {
									const imgEl = imageData.element.querySelector('img') || imageData.element.createEl('img');
									const loadingTextEl = imageData.element.querySelector('.nig-loading-text') ||
										imageData.element.createDiv('nig-loading-text');
									loadingTextEl.setText(t('loading'));

									await this.loadImageUnified(path, imgEl, imageData.element, loadingTextEl as HTMLElement, isWeiboImage);
								},
								`Loading image: ${path}`
							);
						} catch {
							imageData.hasError = true;
							this.handleImageLoadFailure(imageData.element, t('loadingFailed'));
						} finally {
							// 确保无论成功或失败都减少计数器
							activeLoads--;
							imageData.isLoading = false;
							log.debug(() => `Image processed: ${path}, active loads: ${activeLoads}`);

							// 继续处理队列
							window.setTimeout(processQueue, 0);
						}
					})();
				}
			} finally {
				isProcessingQueue = false;

				const checkQueueStatus = () => {
					// 如果队列不为空但无活跃加载，并且未在处理中，尝试重启处理
					if (loadQueue.length > 0 && activeLoads === 0 && !isProcessingQueue) {
						log.debug(() => `Queue processing may be stalled, attempting restart`);
						window.setTimeout(processQueue, 100);
					}
				};

				// 立即检查一次
				checkQueueStatus();

				if (loadQueue.length > 0) {
					window.setTimeout(checkQueueStatus, 500);
				}
			}
		};
		this.queueImageLoad = (imagePath: string, isVisible = false) => {
			const imageData = this.imageDataMap.get(imagePath);
			if (!imageData) return;

			if (!imageData.isLoading && !imageData.hasError &&
				!loadQueue.some(item => item.path === imagePath)) {
				const priority = isVisible ? 'high' : 'low';
				log.debug(() => `Queuing image: ${imagePath}, queue length: ${loadQueue.length}, active loads: ${activeLoads}`);
				loadQueue.push({
					path: imagePath,
					retries: 0,
					priority: priority,
					timestamp: Date.now()
				});
				sortQueue();  // 立即排序
				window.setTimeout(processQueue, 0);
			}
		};

		const queueMonitor = window.setInterval(() => {
			if (loadQueue.length > 0 || activeLoads > 0) {
				log.debug(() => `Queue monitor - queue length: ${loadQueue.length}, active loads: ${activeLoads}, processing: ${isProcessingQueue}`);

				// 如果队列有内容但没有活跃加载，并且未处理中，尝试重启队列处理
				if (loadQueue.length > 0 && activeLoads === 0 && !isProcessingQueue) {
					log.debug(() => 'Queue appears stuck, attempting restart');
					window.setTimeout(processQueue, 100);
				}
			}
		}, 5000);

		this.cleanupQueueMonitor = () => {
			window.clearInterval(queueMonitor);
		};
	}

	private updateElementPositions() {
		const container = this.contentEl.querySelector('.nig-image-wall-container');
		if (!container) return;

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
	}

	private setupVirtualScroll() {
		const container = this.contentEl.querySelector('.nig-image-wall-container');
		if (!container) return;

		const BUFFER_SIZE = 1000;
		const boundUpdateElementPositions = () => this.updateElementPositions();

		window.setTimeout(boundUpdateElementPositions, 500);

		// 简化的滚动处理
		const scrollHandler = () => {
			const scrollTop = container.scrollTop;
			const viewportHeight = container.clientHeight;
			const viewportTop = scrollTop - BUFFER_SIZE;
			const viewportBottom = scrollTop + viewportHeight + BUFFER_SIZE;

			const activeFilterBtn = this.contentEl.querySelector('.nig-filter-btn.nig-active');
			const currentFilter = (activeFilterBtn as HTMLElement | null)?.dataset.filter ?? 'all';

			this.imageDataMap.forEach((data) => {
				if (!data.position) return;

				const isRemote = data.path.startsWith('http://') || data.path.startsWith('https://');
				const matchesFilter = this.checkFilterMatch(currentFilter, isRemote);

				if (!matchesFilter) {
					data.element.setCssStyles({display: 'none'});
					return;
				}

				data.element.setCssStyles({display: ''});

				const isVisible = data.position.bottom >= viewportTop && data.position.top <= viewportBottom;

				if (isVisible) {
					if (!data.isLoading && !data.objectUrl && !data.hasError) {
						this.queueImageLoad(data.path, true);
					}
					data.element.setCssStyles({visibility: ''});
					this.ensureImageVisible(data);
				} else {
					data.element.setCssStyles({visibility: 'hidden'});
					if (!data.isLoading && !data.objectUrl && !data.hasError) {
						this.queueImageLoad(data.path, false);
					}
				}
			});
		};

		const resizeObserver = new ResizeObserver(() => {
			boundUpdateElementPositions();
			scrollHandler();
		});
		resizeObserver.observe(container);

		const imageLoadHandler = () => {
			window.setTimeout(() => {
				boundUpdateElementPositions();
				scrollHandler();
			}, 50);
		};

		container.addEventListener('scroll', scrollHandler);
		window.addEventListener('resize', boundUpdateElementPositions);

		this.imageDataMap.forEach((data) => {
			const img = data.element.querySelector('img');
			if (img) {
				img.addEventListener('load', imageLoadHandler, {once: true});
			}
		});

		this.cleanupVirtualScroll = () => {
			resizeObserver.disconnect();
			container.removeEventListener('scroll', scrollHandler);
			window.removeEventListener('resize', boundUpdateElementPositions);
		};
	}

	private checkFilterMatch(filter: string, isRemote: boolean): boolean {
		return filter === 'all' ||
			(filter === 'local' && !isRemote) ||
			(filter === 'remote' && isRemote);
	}

	private ensureImageVisible(data: ImageData): void {
		const images = Array.from(data.element.querySelectorAll('img'));
		images.forEach(imgEl => {
			const currentOpacity = window.getComputedStyle(imgEl).opacity;
			if (imgEl.complete && imgEl.naturalWidth > 0 && currentOpacity !== '1') {
				imgEl.setCssStyles({opacity: '1'});
				imgEl.setAttribute('complete', 'true');
				imgEl.classList.add('nig-loaded');
			}
		});
	}

	private sortImages(sortType: string) {
		// 保存当前的排序类型
		this.currentSortType = sortType;

		const container = this.contentEl.querySelector('.nig-image-wall');
		if (!container) return;

		const items = Array.from(container.querySelectorAll('.nig-image-item'));

		log.debug(() => `Sorting images, total: ${items.length}, type: ${sortType}`);

		// 根据排序类型排序
		if (sortType === 'size-desc' || sortType === 'size-asc') {
			// 过滤出已加载的图片（只要naturalWidth > 0就认为已加载，不依赖complete属性）
			const loadedItems = items.filter(item => {
				const img = item.querySelector('img');
				const imagePath = item.getAttribute('data-path');
				// 关键修改：只检查naturalWidth，不检查complete
				const isLoaded = img && img.naturalWidth > 0;

				if (img) {
					log.debug(() => `Checking image [${imagePath}]: complete=${img.complete}, naturalWidth=${img.naturalWidth}, naturalHeight=${img.naturalHeight}, isLoaded=${isLoaded}`);
				}

				return isLoaded;
			});

			// 未加载的图片
			const unloadedItems = items.filter(item => {
				const img = item.querySelector('img');
				return !img || img.naturalWidth === 0;
			});

			log.debug(() => `Loaded images: ${loadedItems.length}, unloaded: ${unloadedItems.length}`);

			// 对已加载的图片按尺寸排序
			loadedItems.sort((a, b) => {
				const aSize = this.getImageSize(a);
				const bSize = this.getImageSize(b);
				log.debug(() => `Comparing image sizes - A: ${aSize}, B: ${bSize}`);
				return sortType === 'size-desc' ? bSize - aSize : aSize - bSize;
			});

			// 先添加已排序的图片，再添加未加载的图片
			loadedItems.forEach(item => container.appendChild(item));
			unloadedItems.forEach(item => container.appendChild(item));

			log.debug(() => `Sort complete, reordered ${loadedItems.length} loaded images`);
		} else {
			// 默认排序：恢复原始顺序（按照imageDataMap的顺序）
			const originalOrder: Element[] = [];
			this.imageDataMap.forEach((data) => {
				if (items.includes(data.element)) {
					originalOrder.push(data.element);
				}
			});
			originalOrder.forEach(item => container.appendChild(item));
			log.debug(() => `Restoring default sort`);
		}

		// 排序后更新虚拟滚动的位置信息
		window.setTimeout(() => {
			this.updateElementPositions();
			log.debug(() => `Position info updated after sort`);
		}, 100);
	}

	private getImageSize(element: Element): number {
		const img = element.querySelector('img');
		if (!img) return 0;

		const width = img.naturalWidth || 0;
		const height = img.naturalHeight || 0;
		const size = width * height;

		// 只在图片实际加载时记录尺寸
		if (size > 0) {
			log.debug(() => `Image size: ${width}x${height} = ${size}`);
		}

		return size;
	}

	private filterImages(filterType: string) {
		// 首先更新所有图片的显示状态
		this.imageDataMap.forEach((data) => {
			const imagePath = data.path;
			const isRemote = imagePath.startsWith('http://') || imagePath.startsWith('https://');

			if (filterType === 'all' || (filterType === 'local' && !isRemote) || (filterType === 'remote' && isRemote)) {
				data.element.setCssStyles({ display: '', visibility: '' });
			} else {
				data.element.setCssStyles({ display: 'none' });
			}
		});

		// 在筛选后更新位置信息，然后再触发滚动处理
		const container = this.contentEl.querySelector('.nig-image-wall-container');
		if (container) {
			// 更新位置信息
			window.setTimeout(() => {
				this.imageDataMap.forEach((data) => {
					const el = data.element;
					if (el && window.getComputedStyle(el).display !== 'none') {
						const rect = el.getBoundingClientRect();
						data.position = {
							top: rect.top + container.scrollTop,
							bottom: rect.bottom + container.scrollTop,
							height: rect.height
						};
					}
				});

				// 然后触发滚动事件
				container.dispatchEvent(new Event('scroll'));
			}, 100); // 增加短暂延迟确保DOM已更新
		}
	}

	private createImageElement(imagePath: string, imageWall: HTMLElement) {
		const imageDiv = imageWall.createDiv('nig-image-item');
		imageDiv.setAttribute('data-path', imagePath);

		// 存储图片元素引用
		this.imageDataMap.set(imagePath, {
			path: imagePath,
			element: imageDiv,
			isLoading: false,
			hasError: false
		});

		// 监听此元素以实现懒加载
		this.intersectionObserver?.observe(imageDiv);

		// 添加点击事件用于查看大图
		imageDiv.addEventListener('click', (e) => {
			// 阻止事件冒泡，避免与其他插件（如 Image Toolkit）冲突
			e.stopPropagation();
			e.preventDefault();

			const currentIndex = this.images.indexOf(imagePath);
			this.createLightboxWithNavigation(currentIndex);
		});

		imageDiv.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			const img = imageDiv.querySelector('img');
			if (img) {
				this.createContextMenu(e, img);
			}
		});
	}

	/**
	 * 分批渲染图片元素，避免阻塞主线程
	 */
	private async renderImagesInBatches(imageWall: HTMLElement): Promise<void> {
		const BATCH_SIZE = 50;
		const fragment = document.createDocumentFragment();

		for (let i = 0; i < this.images.length; i++) {
			if (this.isClosed) return;

			const imagePath = this.images[i];
			const imageDiv = document.createElement('div');
			imageDiv.className = 'nig-image-item';
			imageDiv.setAttribute('data-path', imagePath);

			// 存储图片元素引用
			this.imageDataMap.set(imagePath, {
				path: imagePath,
				element: imageDiv,
				isLoading: false,
				hasError: false
			});

			// 添加点击事件
			imageDiv.addEventListener('click', (e) => {
				e.stopPropagation();
				e.preventDefault();
				const currentIndex = this.images.indexOf(imagePath);
				this.createLightboxWithNavigation(currentIndex);
			});

			imageDiv.addEventListener('contextmenu', (e) => {
				e.preventDefault();
				const img = imageDiv.querySelector('img');
				if (img) {
					this.createContextMenu(e, img);
				}
			});

			fragment.appendChild(imageDiv);

			// 每批次渲染后让出主线程
			if ((i + 1) % BATCH_SIZE === 0) {
				imageWall.appendChild(fragment);
				await new Promise(resolve => window.setTimeout(resolve, 0));
			}
		}

		// 添加剩余元素
		if (fragment.childNodes.length > 0) {
			imageWall.appendChild(fragment);
		}

		// 渲染完成后设置懒加载观察
		this.imageDataMap.forEach((data) => {
			this.intersectionObserver?.observe(data.element);
		});
	}

	private async loadLocalImageEnhanced(
		imagePath: string,
		img: HTMLImageElement,
		imageDiv: HTMLElement,
		loadingText: HTMLElement
	): Promise<void> {
		return new Promise((resolve, reject) => {
			log.debug(() => `Enhanced local image loading: ${imagePath}`);

			img.onload = () => {
				log.debug(() => `Local image loaded: ${imagePath}`);
				this.handleImageLoadSuccess(img, imageDiv, loadingText, imagePath);

				const imageData = this.imageDataMap.get(imagePath);
				if (imageData) {
					imageData.isLoading = false;
				}

				resolve();
			};

			img.onerror = async (e) => {
				log.error(() => `Local image load failed (${img.src}): ${imagePath}`);

				try {
					const alternativePaths = this.plugin.imageLoader.getAlternativeLocalPaths(imagePath);
					for (const path of alternativePaths) {
						log.debug(() => `Trying alternative path: ${path}`);

						const success = await this.plugin.imageLoader.loadLocalImage(path, img);
						if (success) {
							// 加载成功，等待onload事件处理
							return;
						}
					}

					this.handleImageLoadFailure(imageDiv, t('imageNotFound'));

					// 更新图片数据状态
					const imageData = this.imageDataMap.get(imagePath);
					if (imageData) {
						imageData.hasError = true;
						imageData.isLoading = false;
					}

					const error = e instanceof Error ? e : new Error('Image load failed');
					reject(error);
				} catch (error) {
					log.error(() => `Error processing alternative path:`, error instanceof Error ? error : undefined);

					// 显示错误
					this.handleImageLoadFailure(imageDiv, t('processingFailed'));

					const imageData = this.imageDataMap.get(imagePath);
					if (imageData) {
						imageData.hasError = true;
						imageData.isLoading = false;
					}

					const err = error instanceof Error ? error : new Error('Image load failed');
					reject(err);
				}
			};

			this.plugin.imageLoader.loadLocalImage(imagePath, img)
				.then(success => {
					if (!success) {
						// 如果加载失败，回退到标准方法
						img.src = this.plugin.imageLoader.getResourcePath(imagePath);
					}
				})
				.catch((error: unknown) => {
					log.error(() => `Loader failed, falling back to standard method: ${imagePath}`, error instanceof Error ? error : undefined);
					img.src = this.plugin.imageLoader.getResourcePath(imagePath);
				});
		});
	}

	private async tryAdvancedImageLoading(
		imagePath: string,
		img: HTMLImageElement,
		imageDiv: HTMLElement,
		loadingText: HTMLElement,
		resolve: () => void,
		reject: (error: unknown) => void,
		isWeiboImage = false
	): Promise<void> {
		let isNetworkImage = false;
		try {
			isNetworkImage = imagePath.startsWith('http://') || imagePath.startsWith('https://');

			if (isNetworkImage) {
				// 尝试使用Obsidian的图片加载器（对于非微博图片非常有效）
				if (!isWeiboImage) {
					const success = await this.plugin.imageLoader.loadNetworkImage(imagePath, img);
					if (success) {
						// 等待图片实际加载完成
						await new Promise<void>((imgResolve, imgReject) => {
							img.onload = () => {
								this.handleImageLoadSuccess(img, imageDiv, loadingText, imagePath);
								imgResolve();
							};
							img.onerror = imgReject;

							// 设置超时
							window.setTimeout(() => imgReject(new Error('Timeout')), 10000);
						});

						resolve();
						return;
					}
				}

				await this.loadWithCustomFetch(imagePath, img, imageDiv, loadingText, resolve, reject, isWeiboImage);
			} else {
				// 本地图片
				await this.loadLocalImageEnhanced(imagePath, img, imageDiv, loadingText);
				resolve();
			}
		} catch (error) {
			log.error(() => `Advanced load attempt failed: ${imagePath}`, error instanceof Error ? error : undefined);

			// 最后的回退方案 - 直接设置URL
			if (isNetworkImage) {
				this.loadImageDirectly(imagePath, img, imageDiv, loadingText, resolve, reject, isWeiboImage);
			} else {
				reject(error);
			}
		}
	}

	private async loadWithCustomFetch(
		imagePath: string,
		img: HTMLImageElement,
		imageDiv: HTMLElement,
		loadingText: HTMLElement,
		resolve: () => void,
		reject: (error: unknown) => void,
		isWeiboImage = false
	): Promise<void> {
		try {
			const response = await requestUrl({
				url: imagePath,
				method: 'GET',
				headers: {
					'Referer': isWeiboImage ? 'https://weibo.com/' : 'https://obsidian.md/',
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
				}
			});

			if (response.status !== 200 && !isWeiboImage) { // no-cors 模式下无法检查状态
				throw new Error(`HTTP error: ${response.status}`);
			}

			const blob = new Blob([response.arrayBuffer], { type: response.headers['content-type'] || 'image/jpeg' });
			const objectUrl = this.resourceManager.createObjectURL(imagePath, blob);

			img.onload = () => {
				this.handleImageLoadSuccess(img, imageDiv, loadingText, imagePath);

				resolve();
			};

			img.onerror = (e) => {
				log.error(() => `Failed to load image from objectURL: ${imagePath}`);
				URL.revokeObjectURL(objectUrl);
				// 最后一次尝试直接加载
				this.loadImageDirectly(imagePath, img, imageDiv, loadingText, resolve, reject, isWeiboImage);
			};

			img.src = objectUrl;

			const imageData = this.imageDataMap.get(imagePath);
			if (imageData) {
				imageData.objectUrl = objectUrl;
			}

			try {
				// 尝试缓存图片
				const contentType = blob.type || response.headers['content-type'] || 'image/jpeg';
				const etag = response.headers['etag'];

				log.info(() => `Caching network image: ${imagePath}`);
				log.debug(() => `Cache details - type: ${contentType}, size: ${Math.round(blob.size / 1024)}KB`);

				const arrayBuffer = await blob.arrayBuffer();

				try {
					await this.plugin.imageCacheService.cacheImage(
						imagePath,
						arrayBuffer,
						etag || undefined,
						contentType
					);
					log.info(() => `✓ Network image cached: ${imagePath}`);
				} catch (cacheError) {
					log.error(() => `✗ Network image cache failed: ${imagePath}`, cacheError instanceof Error ? cacheError : undefined);
				}
			} catch (error) {
				log.error(() => 'Error during image caching:', error instanceof Error ? error : undefined);
			}
		} catch (error) {
			log.error(() => `Custom fetch load failed: ${imagePath}`, error instanceof Error ? error : undefined);
			// 直接进入简单加载模式
			this.loadImageDirectly(imagePath, img, imageDiv, loadingText, resolve, reject, isWeiboImage);
		}
	}

	private loadImageDirectly(
		imagePath: string,
		img: HTMLImageElement,
		imageDiv: HTMLElement,
		loadingText: HTMLElement,
		resolve: () => void,
		reject: (error: unknown) => void,
		isWeiboImage = false
	): void {
		log.debug(() => `Direct image load: ${imagePath}`);

		// 添加对已成功加载的图片进行缓存的功能
		const setupCaching = (imageElement: HTMLImageElement) => {
			if (!this.plugin.settings.enableCache) return;

			// 仅对网络图片（尤其是微博图片）启用缓存
			if (!(imagePath.startsWith('http://') || imagePath.startsWith('https://'))) return;

			try {
				// 创建画布来获取图片数据
				const canvas = document.createElement('canvas');
				canvas.width = imageElement.naturalWidth;
				canvas.height = imageElement.naturalHeight;

				const ctx = canvas.getContext('2d');
				if (!ctx) {
					log.error(() => `Cannot create canvas context for caching: ${imagePath}`);
					return;
				}

				// 绘制图片到画布
				ctx.drawImage(imageElement, 0, 0);

				// 将画布内容转换为Blob
				// 注意：如果canvas被污染(tainted)，toBlob会失败
				try {
					canvas.toBlob((blob) => {
						if (!blob) {
							log.error(() => `Cannot create Blob from canvas: ${imagePath}`);
							return;
						}

						void (async () => {
							try {
								log.debug(() => `Creating cache from directly loaded image: ${imagePath}, size: ${Math.round(blob.size / 1024)}KB`);

								// 转换为ArrayBuffer
								const arrayBuffer = await blob.arrayBuffer();

								// 调用缓存服务
								await this.plugin.imageCacheService.cacheImage(
									imagePath,
									arrayBuffer,
									undefined,
									blob.type || 'image/jpeg'
								);

								log.debug(() => `Successfully cached directly loaded image: ${imagePath}`);
							} catch (error) {
								const errorMsg = error instanceof Error ? error.message : String(error);
								log.error(() => `Failed to cache directly loaded image: ${imagePath}, error: ${errorMsg}`, error instanceof Error ? error : undefined);
							}
						})();
					}, 'image/jpeg', 0.95); // 使用JPEG格式，95%质量
				} catch (blobError) {
					// 捕获SecurityError (canvas被污染时)
					if (blobError instanceof DOMException && blobError.name === 'SecurityError') {
						log.debug(() => `Cross-origin image cannot be cached via canvas (CORS): ${imagePath}`);
					} else {
						throw blobError;
					}
				}
			} catch (error) {
				// 只记录非SecurityError的错误
				if (!(error instanceof DOMException && error.name === 'SecurityError')) {
					log.error(() => `Error setting image cache: ${imagePath}`, error instanceof Error ? error : undefined);
				}
			}
		};

		img.onload = () => {
			log.debug(() => `Image loaded directly: ${imagePath}`);
			this.handleImageLoadSuccess(img, imageDiv, loadingText, imagePath);

			// 图片加载成功后尝试缓存
			setupCaching(img);

			resolve();
		};

		img.onerror = async (e) => {
			const err = e instanceof Error ? e : new Error(`Image direct load failed: ${imagePath}`);
			log.error(() => `Image direct load failed: ${imagePath}`, err);

			// 尝试从缓存降级加载
			if (this.plugin.settings.enableCache) {
				try {
					const cached = await this.plugin.imageCacheService.getCachedImage(imagePath);
					if (cached && !this.isClosed) {
						log.debug(() => `Fallback load from cache: ${imagePath}`);
						img.src = cached.data;
						return;
					}
				} catch {
					log.debug(() => `Cache fallback failed: ${imagePath}`);
				}
			}

			// 对于本地图片尝试替代路径
			if (!imagePath.startsWith('http://') && !imagePath.startsWith('https://')) {
				const alternativePath = this.tryAlternativeLocalPath(imagePath);
				if (alternativePath && alternativePath !== img.src) {
					log.debug(() => `Trying alternative path: ${alternativePath}`);
					img.src = alternativePath;
					return; // 返回等待新路径的加载结果
				}
			}

			this.handleImageLoadFailure(imageDiv, t('loadingFailed'));
			reject(err);
		};

		// 如果是微博图片，尝试使用 Obsidian 的 requestUrl API
		if (isWeiboImage) {
			try {
				log.debug(() => `Loading Weibo image via requestUrl: ${imagePath}`);

				requestUrl({
					url: imagePath,
					method: 'GET',
					headers: {
						'Referer': 'https://weibo.com/',
						'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
					}
				}).then(async (response: { arrayBuffer: ArrayBuffer; headers: { [x: string]: string; }; }) => {
					try {
						const arrayBuffer = response.arrayBuffer;
						const blob = new Blob([arrayBuffer], {type: response.headers['content-type'] || 'image/jpeg'});
						const objectUrl = this.resourceManager.createObjectURL(imagePath, blob);

						img.src = objectUrl;

						const imageData = this.imageDataMap.get(imagePath);
						if (imageData) {
							imageData.objectUrl = objectUrl;
						}

						// 尝试缓存图片
						try {
							const contentType = response.headers['content-type'] || 'image/jpeg';
							log.debug(() => `Caching Weibo image from requestUrl: ${imagePath}, type: ${contentType}`);

							await this.plugin.imageCacheService.cacheImage(
								imagePath,
								arrayBuffer,
								undefined,
								contentType
							);

							log.debug(() => `Weibo image cached: ${imagePath}`);
						} catch (cacheError) {
							log.error(() => `Failed to cache Weibo image: ${imagePath}`, cacheError instanceof Error ? cacheError : undefined);
						}
					} catch (error) {
						log.error(() => 'Failed to process requestUrl response:', error instanceof Error ? error : undefined);
						img.src = imagePath; // 失败时尝试直接设置
					}
				}).catch((error: Error | undefined) => {
					log.error(() => `requestUrl failed to load Weibo image: ${imagePath}`, error instanceof Error ? error : undefined);
					img.src = imagePath; // 失败时尝试直接设置
				});

				return; // 等待 requestUrl 结果
			} catch (e) {
				log.debug(() => `requestUrl unavailable, setting src directly: ${e}`);
			}
		}

		// 所有其他情况：直接设置src
		if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
			// 设置crossOrigin允许canvas读取跨域图片（用于缓存）
			// 如果服务器不支持CORS，图片仍能加载，但canvas会被污染
			img.crossOrigin = 'anonymous';
			img.src = imagePath;
		} else {
			// 本地图片
			try {
				if (this.isObsidianResourcePath(imagePath)) {
					img.src = this.getResourcePath(imagePath);
				} else {
					const realPath = this.getLinkPath(imagePath);
					if (realPath) {
						img.src = this.getResourcePath(realPath);
					} else {
						img.src = this.getResourcePath(imagePath);
					}
				}
			} catch (error) {
				log.error(() => `Failed to resolve local image path: ${imagePath}`, error instanceof Error ? error : undefined);
				this.handleImageLoadFailure(imageDiv, t('imageNotFound'));
				reject(error);
			}
		}
	}

	private isObsidianResourcePath(path: string): boolean {
		// Obsidian资源路径通常包含_resources或_attachments目录
		return path.includes('/_resources/') ||
			path.includes('/_attachments/') ||
			path.includes('/_assets/') ||
			path.match(/\/[^/]+\/[^/]+\.(png|jpg|jpeg|gif|svg|webp)$/i) !== null;
	}

	// 尝试替代本地路径格式
	private tryAlternativeLocalPath(originalPath: string): string | null {
		try {
			// 尝试几种常见的路径变形
			const pathOptions = [
				originalPath,
				// 移除前导的/
				originalPath.startsWith('/') ? originalPath.substring(1) : originalPath,
				// 添加前导的/
				!originalPath.startsWith('/') ? '/' + originalPath : originalPath,
				// 尝试资源目录前缀
				originalPath.includes('_resources') ? originalPath : `_resources/${originalPath}`,
				// 尝试移除资源目录前缀
				originalPath.replace(/^_resources\//, ''),
				// 尝试当前文件相对路径（如果有活动文件）
				this.getRelativePathToActiveFile(originalPath)
			];

			for (const path of pathOptions) {
				if (!path) continue;

				const file = this.app.vault.getAbstractFileByPath(path);
				if (file instanceof TFile) {
					return this.getResourcePath(file.path);
				}

				const linkedFile = this.app.metadataCache.getFirstLinkpathDest(path, '');
				if (linkedFile instanceof TFile) {
					return this.getResourcePath(linkedFile.path);
				}
			}

			return this.getResourcePath(originalPath);
		} catch (error) {
			log.error(() => 'Failed trying alternative path:', error instanceof Error ? error : undefined);
			return null;
		}
	}

	// 获取相对于当前活动文件的路径
	private getRelativePathToActiveFile(path: string): string | null {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) return null;

		const activeDir = activeFile.parent ? activeFile.parent.path : '';

		// 构建相对路径
		return activeDir ? `${activeDir}/${path}` : path;
	}

	private handleImageLoadSuccess(img: HTMLImageElement, imageDiv: HTMLElement, loadingText: HTMLElement, imagePath: string): void {
		log.debug(() => `Image load success: ${imagePath}, width: ${img.naturalWidth}, height: ${img.naturalHeight}, complete: ${img.complete}`);

		if (loadingText && loadingText.parentNode) {
			loadingText.remove();
		}

		// 移除占位符
		const placeholder = imageDiv.querySelector('.nig-image-placeholder');
		if (placeholder) {
			placeholder.remove();
		}

		// 计算并设置网格跨度
		let ratio = 1;
		if (img.naturalWidth > 0 && img.naturalHeight > 0) {
			ratio = img.naturalHeight / img.naturalWidth;
		}

		const baseHeight = 10;
		const heightSpan = Math.min(Math.ceil(ratio * baseHeight), 30);

		imageDiv.setCssStyles({ gridRowEnd: `span ${heightSpan}` });

		// 强制设置图片可见
		img.setCssStyles({ opacity: '1' });
		img.setAttribute('complete', 'true');
		img.classList.add('nig-loaded');

		void img.offsetHeight; // 触发重绘

		// 确保样式被应用（额外保障）
		window.setTimeout(() => {
			if (window.getComputedStyle(img).opacity !== '1') {
				log.debug(() => `Fixing delayed display: ${imagePath}`);
				img.setCssStyles({ opacity: '1' });
				img.classList.add('nig-loaded');

				// 触发父元素重新计算布局
				if (imageDiv.parentElement) {
					void imageDiv.parentElement.offsetHeight; // Force reflow
				}
			}
		}, 50);

		this.loadedImages++;
		this.updateProgressBar();

		const imageData = this.imageDataMap.get(imagePath);
		if (imageData) {
			imageData.isLoading = false;
		}

		// 如果当前有非默认的排序选项，使用防抖延迟重新应用排序
		if (this.currentSortType !== 'default') {
			this.debouncedSort(this.currentSortType);
		}
	}

	private async loadImageUnified(
		imagePath: string,
		img: HTMLImageElement,
		imageDiv: HTMLElement,
		loadingText: HTMLElement,
		isWeiboImage = false
	): Promise<void> {
		if (this.isClosed) return;

		const imageData = this.imageDataMap.get(imagePath);
		if (!imageData) {
			throw new Error('Image data not found');
		}

		const isNetworkImage = imagePath.startsWith('http://') || imagePath.startsWith('https://');

		// 对于网络图片，先检查缓存
		if (isNetworkImage) {
			try {
				if (this.plugin.settings.enableCache) {
					log.debug(() => `Checking image cache: ${imagePath}`);

					// 异步获取缓存
					const cachedImage = await this.plugin.imageCacheService.getCachedImage(imagePath);

					if (this.isClosed) return;

					if (cachedImage) {
						log.info(() => `✓ Cache hit, loading from cache: ${imagePath}`);
						loadingText.setText(t('loadingFromCache'));

						await new Promise<void>((resolve, reject) => {
							img.onload = () => {
								if (this.isClosed) return;
								log.info(() => `✓ Cached image loaded: ${imagePath}`);
								this.handleImageLoadSuccess(img, imageDiv, loadingText, imagePath);
								resolve();
							};

							img.onerror = (e) => {
								const error = e instanceof Error ? e : new Error(`Failed to load cached image: ${imagePath}`);
								log.error(() => `✗ Cached image load failed: ${imagePath}`, error);
								reject(error);
							};

							// 设置图片源为缓存的base64数据
							img.src = cachedImage.data;
						}).catch(async () => {
							if (this.isClosed) return;
							// 缓存加载失败，尝试网络加载
							await this.tryNetworkImageLoading(imagePath, img, imageDiv, loadingText, () => {}, () => {}, isWeiboImage);
						});
						return;
					} else {
						log.debug(() => `Cache miss, loading from network: ${imagePath}`);
					}
				} else {
					log.debug(() => `Image cache disabled`);
				}
			} catch (error) {
				log.error(() => `Error fetching cache: ${imagePath}`, error instanceof Error ? error : undefined);
			}

			if (this.isClosed) return;
			// 缓存未命中或禁用，尝试网络加载
			await this.tryNetworkImageLoading(imagePath, img, imageDiv, loadingText, () => {}, () => {}, isWeiboImage);
		} else {
			// 本地图片，使用原有逻辑
			await this.tryAdvancedImageLoading(imagePath, img, imageDiv, loadingText, () => {}, () => {}, isWeiboImage);
		}
	}

	private async tryNetworkImageLoading(
		imagePath: string,
		img: HTMLImageElement,
		imageDiv: HTMLElement,
		loadingText: HTMLElement,
		resolve: () => void,
		reject: (error: unknown) => void,
		isWeiboImage: boolean
	): Promise<void> {
		// 除非是微博图片，否则先尝试直接加载
		if (!isWeiboImage) {
			// 设置crossOrigin允许canvas读取跨域图片
			img.crossOrigin = 'anonymous';

			const directLoadSuccess = await new Promise<boolean>((imgResolve) => {
				const onload = async () => {
					log.debug(() => `Network image loaded directly: ${imagePath}`);
					this.handleImageLoadSuccess(img, imageDiv, loadingText, imagePath);

					// 直接加载成功后，尝试缓存图片
					if (this.plugin.settings.enableCache) {
						await this.cacheLoadedImage(imagePath, img);
					}

					resolve();
					imgResolve(true);
				};

				const onerror = (e: Event | string) => {
					log.error(() => `Direct network image load failed: ${imagePath}, trying advanced method`);
					imgResolve(false);
				};

				img.onload = onload;
				img.onerror = onerror;
				img.src = imagePath;

				// 设置超时
				window.setTimeout(() => {
					if (!img.complete || img.naturalWidth === 0) {
						onerror('timeout');
					}
				}, 5000);
			});

			if (directLoadSuccess) {
				return;
			}
		}

		// 直接加载失败或是微博图片，使用高级加载方法
		await this.tryAdvancedImageLoading(imagePath, img, imageDiv, loadingText, resolve, reject, isWeiboImage);
	}

	private async cacheLoadedImage(imagePath: string, img: HTMLImageElement): Promise<void> {
		try {
			// 创建画布来获取图片数据
			const canvas = document.createElement('canvas');
			canvas.width = img.naturalWidth;
			canvas.height = img.naturalHeight;

			const ctx = canvas.getContext('2d');
			if (!ctx) {
				log.error(() => `Cannot create canvas context for caching: ${imagePath}`);
				return;
			}

			// 绘制图片到画布
			ctx.drawImage(img, 0, 0);

			// 将画布内容转换为Blob
			await new Promise<void>((blobResolve) => {
				canvas.toBlob((blob) => {
					if (!blob) {
						log.error(() => `Cannot create Blob from canvas: ${imagePath}`);
						blobResolve();
						return;
					}

					void (async () => {
						try {
							log.debug(() => `Creating cache from directly loaded image: ${imagePath}, size: ${Math.round(blob.size / 1024)}KB`);

							// 转换为ArrayBuffer
							const arrayBuffer = await blob.arrayBuffer();

							// 调用缓存服务
							await this.plugin.imageCacheService.cacheImage(
								imagePath,
								arrayBuffer,
								undefined,
								blob.type || 'image/jpeg'
							);

							log.info(() => `✓ Successfully cached directly loaded image: ${imagePath}`);
						} catch (error) {
							log.error(() => `Failed to cache directly loaded image: ${imagePath}`, error instanceof Error ? error : undefined);
						}
						blobResolve();
					})();
				}, 'image/jpeg', 0.9);
			});
		} catch (error) {
			log.error(() => `Error during image caching: ${imagePath}`, error instanceof Error ? error : undefined);
		}
	}

	private async loadWeiboImage(
		imagePath: string,
		img: HTMLImageElement,
		imageDiv: HTMLElement,
		loadingText: HTMLElement,
		retryCount = 0
	): Promise<void> {
		try {
			// 异步获取缓存
			const cachedImage = await this.plugin.imageCacheService.getCachedImage(imagePath);

			if (cachedImage) {
				log.debug(() => `Loading Weibo image from cache: ${imagePath}`);

				await new Promise<void>((resolve, reject) => {
					img.onload = () => {
						this.handleImageLoadSuccess(img, imageDiv, loadingText, imagePath);
						resolve();
					};

					img.onerror = (e) => {
						const error = e instanceof Error ? e : new Error('Cached Weibo image load error');
						log.error(() => `Cached Weibo image load error`, error);
						reject(error);
					};

					// 设置图片源为缓存的base64数据
					img.src = cachedImage.data;
				}).catch(async (e) => {
					await this.loadWeiboImageWithoutCache(imagePath, img, imageDiv, loadingText, retryCount, () => {}, () => {});
				});
				return;
			}

			await this.loadWeiboImageWithoutCache(imagePath, img, imageDiv, loadingText, retryCount, () => {}, () => {});
		} catch (error) {
			const currentRequestId = imageDiv.getAttribute('data-request-id');
			this.handleError(error instanceof Error ? error : new Error(String(error)), imageDiv, currentRequestId || undefined, retryCount);
			throw error;
		}
	}

	private async loadWeiboImageWithoutCache(
		imagePath: string,
		img: HTMLImageElement,
		imageDiv: HTMLElement,
		loadingText: HTMLElement,
		retryCount: number,
		resolve: () => void,
		reject: (error: unknown) => void
	): Promise<void> {
		// 使用 Obsidian 的 requestUrl API 代替 electron.remote
		const MAX_RETRIES = 3;

		try {
			log.debug(() => `Loading Weibo image via requestUrl (no cache): ${imagePath}`);

			const response = await requestUrl({
				url: imagePath,
				method: 'GET',
				headers: {
					'Referer': 'https://weibo.com/',
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
				}
			});

			if (response.status !== 200) {
				throw new Error(`HTTP Error: ${response.status}`);
			}

			const arrayBuffer = response.arrayBuffer;
			const contentType = response.headers['content-type'] || 'image/jpeg';
			const blob = new Blob([arrayBuffer], {type: contentType});

			// 使用 ResourceManager 管理 objectURL
			const objectUrl = this.resourceManager.createObjectURL(imagePath, blob);

			img.onload = () => {
				if (loadingText && loadingText.parentNode) {
					loadingText.remove();
				}

				// 移除占位符
				const placeholder = imageDiv.querySelector('.nig-image-placeholder');
				if (placeholder) {
					placeholder.remove();
				}

				const ratio = img.naturalHeight / img.naturalWidth;
				const baseHeight = 10;
				const heightSpan = Math.min(Math.ceil(ratio * baseHeight), 30);

				imageDiv.setCssStyles({ gridRowEnd: `span ${heightSpan}` });
				img.setCssStyles({ opacity: '1' });
				this.loadedImages++;
				this.updateProgressBar();

				const imageData = this.imageDataMap.get(imagePath);
				if (imageData) {
					imageData.isLoading = false;
				}

				resolve();
			};

			img.onerror = async () => {
				if (retryCount < MAX_RETRIES) {
					log.debug(() => `Retrying Weibo image load (${retryCount + 1}/${MAX_RETRIES}): ${imagePath}`);
					await this.loadWeiboImage(imagePath, img, imageDiv, loadingText, retryCount + 1);
					resolve();
				} else {
					this.handleImageLoadFailure(imageDiv, t('loadingFailed'));
					reject(new Error('Max retries reached'));
				}
			};

			img.src = objectUrl;

			const imageData = this.imageDataMap.get(imagePath);
			if (imageData) {
				imageData.objectUrl = objectUrl;
			}

			// 尝试缓存图片
			try {
				await this.plugin.imageCacheService.cacheImage(
					imagePath,
					arrayBuffer,
					undefined,
					contentType
				);
				log.debug(() => `Weibo image cached: ${imagePath}`);
			} catch (cacheError) {
				log.error(() => `Failed to cache Weibo image: ${imagePath}`, cacheError instanceof Error ? cacheError : undefined);
			}
		} catch (error) {
			log.error(() => `requestUrl failed to load Weibo image: ${imagePath}`, error instanceof Error ? error : undefined);

			const imageData = this.imageDataMap.get(imagePath);
			if (imageData) {
				imageData.isLoading = false;
			}

			if (retryCount < MAX_RETRIES) {
				log.debug(() => `Retrying after request failure (${retryCount + 1}/${MAX_RETRIES}): ${imagePath}`);
				window.setTimeout(() => {
					this.loadWeiboImage(imagePath, img, imageDiv, loadingText, retryCount + 1)
						.then(resolve)
						.catch(reject);
				}, 1000 * (retryCount + 1));
			} else {
				this.handleImageLoadFailure(imageDiv, t('loadingFailed'));
				reject(error);
			}
		}
	}

	private handleError(error: Error, imageDiv: HTMLElement, requestId: string | undefined, retryCount: number) {
		const MAX_RETRIES = 3;

		log.error(() => 'Error loading Weibo image:', error instanceof Error ? error : undefined);
		if (requestId) {
			this.currentRequests.delete(requestId);
		}

		if (retryCount < MAX_RETRIES) {
			log.debug(() => `Retrying after error (${retryCount + 1}/${MAX_RETRIES})`);
			window.setTimeout(() => {
				const img = imageDiv.querySelector('img');
				const loadingText = imageDiv.querySelector('.nig-loading-text');
				if (img && loadingText) {
					const imgSrc = img.src;
					void this.loadWeiboImage(imgSrc, img, imageDiv, loadingText as HTMLElement, retryCount + 1);
				}
			}, 1000 * (retryCount + 1));
		} else {
			this.handleImageLoadFailure(imageDiv, t('loadingFailed'));
		}
	}

	private updateProgressBar() {
		const progressEl = this.contentEl.querySelector('progress');
		const progressText = this.contentEl.querySelector('.nig-progress-text');
		if (progressEl) {
			progressEl.setAttribute('value', this.loadedImages.toString());

			if (progressText) {
				progressText.setText(`${this.loadedImages}/${this.totalImages}`);
			}

			if (this.loadedImages >= this.totalImages) {
				window.setTimeout(() => {
					const container = this.contentEl.querySelector('.nig-progress-container');
					if (container) {
						container.addClass('nig-complete');
					}
				}, 800);
			}
		}
	}

	private handleImageError(imageDiv: HTMLElement, message: string) {
		imageDiv.empty();
		imageDiv.addClass('nig-error');
		imageDiv.setText(message);
	}

	private handleImageLoadFailure(imageDiv: HTMLElement, message: string) {
		this.handleImageError(imageDiv, message);
		this.loadedImages++;
		this.updateProgressBar();
	}

	private getLinkPath(link: string): string | null {
		try {
			// 如果是直接文件格式，不是Wiki链接
			if (!link.includes('[[') && !link.includes(']]')) {
				// 移除锚点和别名
				const cleanLink = link.split('|')[0].split('#')[0].trim();
				
				// 尝试作为直接文件路径
				const directFile = this.app.vault.getAbstractFileByPath(cleanLink);
				if (directFile instanceof TFile) {
					log.debug(() => `Found direct file path: ${cleanLink}`);
					return directFile.path;
				}

				// 获取当前文件上下文
				const activeFile = this.app.workspace.getActiveFile();
				const sourcePath = activeFile?.path || '';

				// 尝试解析为链接路径
				const dest = this.app.metadataCache.getFirstLinkpathDest(cleanLink, sourcePath);
				if (dest instanceof TFile) {
					log.debug(() => `Resolved as link path: ${dest.path}`);
					return dest.path;
				}

				// 如果是文件名（没有路径），尝试在库中查找
				if (!cleanLink.includes('/')) {
					const allFiles = this.app.vault.getFiles();
					const matchedFiles = allFiles.filter(f => f.name === cleanLink);
					if (matchedFiles.length > 0) {
						log.debug(() => `Found by filename: ${matchedFiles[0].path}`);
						return matchedFiles[0].path;
					}
				}

				// 如果都失败了，尝试添加_resources前缀
				if (!cleanLink.startsWith('_resources/')) {
					const resourcePath = `_resources/${cleanLink}`;
					const resourceFile = this.app.vault.getAbstractFileByPath(resourcePath);
					if (resourceFile instanceof TFile) {
						log.debug(() => `Found resource file: ${resourcePath}`);
						return resourceFile.path;
					}
				}

				return cleanLink;
			}

			// 处理Wiki链接格式 ![[图片]]
			const stripped = link.replace(/!?\[\[(.*?)]]/, '$1');
			// 移除锚点和别名
			const path = stripped.split('|')[0].split('#')[0].trim();

			// 获取当前文件上下文
			const activeFile = this.app.workspace.getActiveFile();
			const sourcePath = activeFile?.path || '';

			const file = this.app.metadataCache.getFirstLinkpathDest(path, sourcePath);
			if (file instanceof TFile) {
				log.debug(() => `Wiki link resolved to: ${file.path}`);
				return file.path;
			}

			return path;
		} catch (error) {
			log.error(() => 'Error getting link path:', error instanceof Error ? error : undefined);
			return null;
		}
	}

	private getResourcePath(path: string): string {
		return this.app.vault.adapter.getResourcePath(path);
	}

	private async copyImageToClipboard(img: HTMLImageElement) {
		const canvas = document.createElement('canvas');
		try {
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
				const blob = await new Promise<Blob>((resolve, reject) => {
					canvas.toBlob((b) => {
						if (b) {
							resolve(b);
						} else {
							reject(new Error('Failed to create blob'));
						}
					}, 'image/png');
				});
				await this.writeToClipboard(blob);
			} catch {
				const blob = await new Promise<Blob>((resolve, reject) => {
					canvas.toBlob((b) => {
						if (b) {
							resolve(b);
						} else {
							reject(new Error('Failed to create blob'));
						}
					}, 'image/jpeg', 0.95);
				});
				await this.writeToClipboard(blob);
			}

			new Notice(t('imageCopied'));
		} catch (err) {
			log.error(() => 'Copy failed:', err instanceof Error ? err : undefined);
			new Notice(t('copyFailed'));
		} finally {
			// Release canvas memory
			canvas.width = 0;
			canvas.height = 0;
		}
	}

	private async writeToClipboard(blob: Blob) {
		try {
			await navigator.clipboard.write([
				new ClipboardItem({
					[blob.type]: blob
				})
			]);
		} catch {
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

			const src = img.src;
			let filename = 'image.png';

			if (src.startsWith('blob:')) {
				filename = 'obsidian-image.png';
			} else {
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

			new Notice(t('downloadingImage'));
		} catch (error) {
			log.error(() => 'Download failed:', error instanceof Error ? error : undefined);
			new Notice(t('downloadFailed'));
		}
	}

	private createContextMenu(e: MouseEvent, img: HTMLImageElement) {
		const menu = document.createElement('div');
		menu.addClass('nig-context-menu');
		menu.setCssStyles({ position: "fixed", left: e.pageX + "px", top: e.pageY + "px" });

		const copyOption = menu.createDiv('nig-menu-item');
		copyOption.setText(t('copyImage'));
		copyOption.onclick = async () => {
			await this.copyImageToClipboard(img);
			menu.remove();
		};

		const downloadOption = menu.createDiv('nig-menu-item');
		downloadOption.setText(t('downloadImage'));
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
		lightbox.addClass('nig-lightbox-overlay');

		// 创建图片容器
		const imgContainer = lightbox.createDiv('nig-lightbox-image-container');
		const img = imgContainer.createEl('img');

		const loadingText = lightbox.createDiv('nig-loading-text');
		loadingText.setText(t('loading'));

		// 追踪当前图片索引的变量
		let currentIndex = initialIndex;
		let isZoomed = false;
		let initialScale = 1;

		// 添加缩放功能
		const zoomImage = (scale: number) => {
			if (!isZoomed && scale > 1) {
				img.setCssStyles({ transform: `scale(${scale})` });
				isZoomed = true;
				initialScale = scale;
			} else if (isZoomed && scale === 1) {
				img.setCssStyles({ transform: 'scale(1)' });
				isZoomed = false;
			} else if (isZoomed) {
				// 已缩放状态下的额外缩放
				img.setCssStyles({ transform: `scale(${initialScale * scale})` });
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

		// 添加右键菜单
		img.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			this.createContextMenu(e, img);
		});

		const navigateImage = async (newIndex: number) => {
			// 处理循环导航
			currentIndex = (newIndex + this.images.length) % this.images.length;

			// 显示加载提示
			loadingText.setCssStyles({ display: 'block' });
			loadingText.setText(t('loading'));

			// 重置缩放状态
			isZoomed = false;
			img.setCssStyles({ transform: 'scale(1)' });

			// 更新图片
			const imagePath = this.images[currentIndex];
			const imageData = this.imageDataMap.get(imagePath);

			// 先设置加载完成和错误的回调，再设置 src
			img.onload = () => {
				loadingText.setCssStyles({ display: 'none' });
			};

			img.onerror = () => {
				loadingText.setCssStyles({ display: 'none' });
				loadingText.setText(t('loadingFailed'));
				window.setTimeout(() => {
					loadingText.setText(t('loading'));
				}, 2000);
			};

			// 设置图片源
			if (imageData && imageData.objectUrl) {
				// 已有 objectUrl，直接使用
				img.src = imageData.objectUrl;
			} else if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
				// 网络图片，需要通过缓存服务加载
				try {
					// 先检查缓存
					if (this.plugin.settings.enableCache) {
						const cachedImage = await this.plugin.imageCacheService.getCachedImage(imagePath);
						if (cachedImage) {
							log.debug(() => `Lightbox: loading network image from cache ${imagePath}`);
							loadingText.setText(t('loadingFromCache'));
							img.src = cachedImage.data;
						} else {
							log.debug(() => `Lightbox: cache miss, triggering image load ${imagePath}`);
							// 缓存未命中，触发图片墙中的加载
							this.queueImageLoad(imagePath, true);
							// 等待一小段时间看是否能获取到 objectUrl
							await this.waitForImageLoad(imagePath, 5000);
							const updatedImageData = this.imageDataMap.get(imagePath);
							if (updatedImageData?.objectUrl) {
								img.src = updatedImageData.objectUrl;
							} else {
								// 如果还是没有，尝试直接加载（可能会遇到CORS）
								img.crossOrigin = 'anonymous';
								img.src = imagePath;
							}
						}
					} else {
						// 缓存禁用，触发加载并等待
						this.queueImageLoad(imagePath, true);
						await this.waitForImageLoad(imagePath, 5000);
						const updatedImageData = this.imageDataMap.get(imagePath);
						if (updatedImageData?.objectUrl) {
							img.src = updatedImageData.objectUrl;
						} else {
							img.crossOrigin = 'anonymous';
							img.src = imagePath;
						}
					}
				} catch (error) {
					log.error(() => `Lightbox: failed to load network image ${imagePath}`, error instanceof Error ? error : undefined);
					// 失败时尝试直接加载
					img.crossOrigin = 'anonymous';
					img.src = imagePath;
				}
			} else {
				// 本地图片
				const newPath = this.getLinkPath(this.images[currentIndex]);
				if (newPath) {
					img.src = this.getResourcePath(newPath);
				}
			}

			// 检查图片是否已经加载完成（处理缓存情况）
			if (img.complete && img.naturalHeight !== 0) {
				loadingText.setCssStyles({ display: 'none' });
			}

			// 更新计数器
			const counter = lightbox.querySelector('.nig-lightbox-counter');
			if (counter) {
				counter.setText(`${currentIndex + 1} / ${this.images.length}`);
			}

			// 预加载相邻图片
			this.preloadAdjacentImages(currentIndex);
		};

		// 初始预加载
		void this.preloadAdjacentImages(initialIndex);

		// 添加左右导航按钮
		if (this.images.length > 1) {
			const prevBtn = lightbox.createDiv('nig-lightbox-nav prev');
			prevBtn.setText('‹'); // 左箭头
			prevBtn.onclick = (e) => {
				e.stopPropagation();
				void navigateImage(currentIndex - 1);
			};

			const nextBtn = lightbox.createDiv('nig-lightbox-nav next');
			nextBtn.setText('›'); // 右箭头
			nextBtn.onclick = (e) => {
				e.stopPropagation();
				void navigateImage(currentIndex + 1);
			};
		}

		// 显示图片计数
		const counter = lightbox.createDiv('nig-lightbox-counter');
		counter.setText(`${currentIndex + 1} / ${this.images.length}`);

		// 添加缩放控制按钮
		const controls = lightbox.createDiv('nig-lightbox-controls');

		const zoomOutBtn = controls.createDiv('nig-zoom-button nig-zoom-out');
		zoomOutBtn.setText('−');
		zoomOutBtn.onclick = (e) => {
			e.stopPropagation();
			zoomImage(1); // 重置缩放
		};

		const zoomInBtn = controls.createDiv('nig-zoom-button nig-zoom-in');
		zoomInBtn.setText('+');
		zoomInBtn.onclick = (e) => {
			e.stopPropagation();
			zoomImage(isZoomed ? 1.5 : 2);
		};

		// 添加关闭按钮
		const closeBtn = lightbox.createDiv('nig-lightbox-close');
		closeBtn.setText('×');
		closeBtn.onclick = () => lightbox.remove();

		// 初始图片
		void navigateImage(currentIndex);

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
					void navigateImage(currentIndex - 1);
					break;
				case 'ArrowRight':
					void navigateImage(currentIndex + 1);
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

	/**
	 * 等待图片加载完成
	 * @param imagePath 图片路径
	 * @param timeout 超时时间（毫秒）
	 * @private
	 */
	private async waitForImageLoad(imagePath: string, timeout = 5000): Promise<void> {
		const startTime = Date.now();
		const checkInterval = 100; // 每100ms检查一次

		return new Promise((resolve) => {
			const checkLoad = () => {
				const imageData = this.imageDataMap.get(imagePath);

				// 如果已加载或出错，或超时，则结束等待
				if (imageData?.objectUrl || imageData?.hasError || (Date.now() - startTime >= timeout)) {
					resolve();
					return;
				}

				// 继续等待
				window.setTimeout(checkLoad, checkInterval);
			};

			checkLoad();
		});
	}

	/**
	 * 预加载相邻图片
	 * @param currentIndex
	 * @private
	 */
	private preloadAdjacentImages(currentIndex: number): void {
		const preloadIndices = [
			(currentIndex + 1) % this.images.length,  // 下一张
			(currentIndex - 1 + this.images.length) % this.images.length  // 上一张
		];

		preloadIndices.forEach(index => {
			const imagePath = this.images[index];
			const imageData = this.imageDataMap.get(imagePath);

			// 如果未加载，加入低优先级队列
			if (imageData && !imageData.objectUrl && !imageData.isLoading && !imageData.hasError) {
				this.queueImageLoad(imagePath, false);
			}
		});
	}

	onClose() {
		this.isClosed = true;

		this.currentRequests.forEach((request) => {
			try {
				if (request.controller) {
					request.controller.abort();
				} else if (request.electronRequest) {
					request.electronRequest.abort();
				}
			} catch (e) {
				log.error(() => 'Error aborting request:', e instanceof Error ? e : undefined);
			}
		});
		this.currentRequests.clear();

		this.resourceManager.revokeAll();
		this.imageDataMap.clear();

		// 清理观察者和事件监听器
		if (this.intersectionObserver) {
			this.intersectionObserver.disconnect();
			this.intersectionObserver = null;
		}

		// 清理队列监控
		if (this.cleanupQueueMonitor) {
			this.cleanupQueueMonitor();
		}

		// 清理虚拟滚动相关事件监听器
		this.cleanupVirtualScroll();

		// 清理排序防抖
		this.debouncedSort.cancel();

		// 重置状态
		this.loadedImages = 0;
		this.imageDataMap.clear();

		this.contentEl.empty();
	}

}
