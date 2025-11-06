import {App, Modal, Notice, TFile} from 'obsidian';
import NoteImageGalleryPlugin from "../main";
import {log} from "../utils/log-utils";
import {RetryHandler} from "../utils/retry-handler";
import {ResourceManager} from "../utils/resource-manager";

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

interface QueueItem {
	path: string;
	retries: number;
	priority: 'high' | 'normal' | 'low';  // 优先级
	timestamp: number;  // 入队时间
}

export class CurrentNoteImageGalleryService extends Modal {
	private images: string[] = [];
	private loadedImages: number = 0;
	private totalImages: number = 0;
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
		contentEl.addClass('current-note-image-gallery');

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

		const filterToolbar = toolbar.createDiv('filter-toolbar');

		const sortContainer = filterToolbar.createDiv('sort-container');
		sortContainer.createSpan({text: '排序: '});
		const sortSelect = sortContainer.createEl('select', {cls: 'sort-select'});
		sortSelect.createEl('option', {text: '默认排序', value: 'default'});
		sortSelect.createEl('option', {text: '按尺寸（大到小）', value: 'size-desc'});
		sortSelect.createEl('option', {text: '按尺寸（小到大）', value: 'size-asc'});

		const filterContainer = filterToolbar.createDiv('filter-container');
		filterContainer.createSpan({text: '筛选: '});
		const allBtn = filterContainer.createEl('button', {text: '全部', cls: 'filter-btn active'});
		const localBtn = filterContainer.createEl('button', {text: '本地图片', cls: 'filter-btn'});
		const remoteBtn = filterContainer.createEl('button', {text: '网络图片', cls: 'filter-btn'});

		sortSelect.addEventListener('change', () => {
			this.sortImages(sortSelect.value);
		});

		[allBtn, localBtn, remoteBtn].forEach(btn => {
			btn.addEventListener('click', (e) => {
				[allBtn, localBtn, remoteBtn].forEach(b => b.removeClass('active'));
				btn.addClass('active');

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
			rootMargin: '200px',
			threshold: 0.01
		});
	}

	private setupBatchLoading() {
		const MAX_CONCURRENT_LOADS = 5;
		const MAX_RETRIES = 3;
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

		const processQueue = async () => {
			if (isProcessingQueue || loadQueue.length === 0 || activeLoads >= MAX_CONCURRENT_LOADS) return;

			isProcessingQueue = true;

			try {
				sortQueue();  // 每次处理前排序

				while (loadQueue.length > 0 && activeLoads < MAX_CONCURRENT_LOADS) {
					const item = loadQueue.shift();
					if (!item) continue;

					const {path, retries} = item;
					const imageData = this.imageDataMap.get(path);

					if (!imageData || imageData.isLoading || imageData.hasError) continue;

					activeLoads++;
					imageData.isLoading = true;

					// 是否为网络图片，以及是否为微博图片
					const isNetworkImage = path.startsWith('http');
					const isWeiboImage = path.includes('.sinaimg.cn');

					log.debug(() => `队列处理图片: ${path}, 是否网络图片: ${isNetworkImage}, 是否微博图片: ${isWeiboImage}, 当前活跃加载: ${activeLoads}`);

					// 异步执行加载操作，确保 activeLoads 计数器正确管理
					(async () => {
						try {
							await this.retryHandler.execute(
								async () => {
									const imgEl = imageData.element.querySelector('img') || imageData.element.createEl('img');
									const loadingTextEl = imageData.element.querySelector('.loading-text') ||
										imageData.element.createDiv('loading-text');
									loadingTextEl.setText('加载中...');

									await this.loadImageUnified(path, imgEl as HTMLImageElement, imageData.element, loadingTextEl as HTMLElement, isWeiboImage);
								},
								`加载图片 ${path}`
							);
						} catch (error) {
							imageData.hasError = true;
							this.handleImageError(imageData.element, '加载失败');
							this.loadedImages++;
							this.updateProgressBar();
						} finally {
							// 确保无论成功或失败都减少计数器
							activeLoads--;
							imageData.isLoading = false;
							log.debug(() => `图片处理完成: ${path}, 当前活跃加载: ${activeLoads}`);

							// 继续处理队列
							setTimeout(processQueue, 0);
						}
					})();
				}
			} finally {
				isProcessingQueue = false;

				const checkQueueStatus = () => {
					// 如果队列不为空但无活跃加载，并且未在处理中，尝试重启处理
					if (loadQueue.length > 0 && activeLoads === 0 && !isProcessingQueue) {
						log.debug(() => `队列处理可能停滞，尝试重启`);
						setTimeout(processQueue, 100);
					}
				};

				// 立即检查一次
				checkQueueStatus();

				if (loadQueue.length > 0) {
					setTimeout(checkQueueStatus, 500);
				}
			}
		};
		this.queueImageLoad = (imagePath: string, isVisible: boolean = false) => {
			const imageData = this.imageDataMap.get(imagePath);
			if (!imageData) return;

			if (!imageData.isLoading && !imageData.hasError &&
				!loadQueue.some(item => item.path === imagePath)) {
				const priority = isVisible ? 'high' : 'low';
				log.debug(() => `将图片加入队列: ${imagePath}, 当前队列长度: ${loadQueue.length}, 当前活跃加载: ${activeLoads}`);
				loadQueue.push({
					path: imagePath,
					retries: 0,
					priority: priority,
					timestamp: Date.now()
				});
				sortQueue();  // 立即排序
				setTimeout(processQueue, 0);
			}
		};

		const queueMonitor = setInterval(() => {
			if (loadQueue.length > 0 || activeLoads > 0) {
				log.debug(() => `队列监控 - 队列长度: ${loadQueue.length}, 活跃加载: ${activeLoads}, 是否处理中: ${isProcessingQueue}`);

				// 如果队列有内容但没有活跃加载，并且未处理中，尝试重启队列处理
				if (loadQueue.length > 0 && activeLoads === 0 && !isProcessingQueue) {
					log.debug(() => '队列似乎卡住了，尝试重启处理');
					setTimeout(processQueue, 100);
				}
			}
		}, 5000);

		this.cleanupQueueMonitor = () => {
			clearInterval(queueMonitor);
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
				if (!data.position) return;

				const imagePath = data.path;
				const isRemote = imagePath.startsWith('http://') || imagePath.startsWith('https://');
				const matchesFilter =
					currentFilter === '全部' || currentFilter === 'all' ||
					((currentFilter === '本地图片' || currentFilter === 'local') && !isRemote) ||
					((currentFilter === '网络图片' || currentFilter === 'remote') && isRemote);

				if (!matchesFilter) {
					data.element.style.display = 'none';
					return;
				}

				// 符合筛选条件的图片一定要显示（设置display为空）
				data.element.style.display = '';

				// 检查是否在可视区域内
				const isVisible = data.position.bottom >= viewportTop &&
					data.position.top <= viewportBottom;

				if (isVisible) {
					// 在可视区域内且符合筛选条件
					if (!data.isLoading && !data.objectUrl && !data.hasError) {
						this.queueImageLoad(data.path, true);
					}
					data.element.style.visibility = ''; // 显示元素

					const images = Array.from(data.element.querySelectorAll('img'));
					images.forEach(imgEl => {
						if (imgEl.complete && imgEl.naturalWidth > 0 && imgEl.style.opacity !== '1') {
							log.debug(() => `修复未显示的图片: ${data.path}`);
							imgEl.style.opacity = '1';
							imgEl.setAttribute('complete', 'true');
							imgEl.classList.add('loaded');
						}
					});
				} else {
					// 不在可视区域内但符合筛选条件
					// 设置为隐藏但保留在DOM中
					data.element.style.visibility = 'hidden';

					// 对不可见的图片，也添加到加载队列，但优先级较低
					if (!data.isLoading && !data.objectUrl && !data.hasError) {
						this.queueImageLoad(data.path, false); // false 表示不在可视区域内
					}
				}
			});

			window.requestAnimationFrame(() => {
				this.imageDataMap.forEach((data) => {
					if (!data.position) return;

					// 再次检查是否在可视区域内
					const isNowVisible = data.position.bottom >= viewportTop &&
						data.position.top <= viewportBottom;

					if (isNowVisible && data.element.style.display !== 'none') {
						// 确保元素可见
						data.element.style.visibility = '';

						// 确保图片加载并显示
						const images = Array.from(data.element.querySelectorAll('img'));
						images.forEach(imgEl => {
							if (imgEl.complete && imgEl.naturalWidth > 0 &&
								(imgEl.style.opacity !== '1' || !imgEl.classList.contains('loaded'))) {
								log.debug(() => `在动画帧中修复未显示的图片: ${data.path}`);
								imgEl.style.opacity = '1';
								imgEl.classList.add('loaded');
							}
						});
					}
				});
			});
		};

		// 使用ResizeObserver监听容器和图片大小变化
		const resizeObserver = new ResizeObserver(() => {
			updateElementPositions();
			scrollHandler();
		});
		resizeObserver.observe(container as Element);

		// 监听图片加载完成，动态更新布局
		const imageLoadHandler = () => {
			setTimeout(() => {
				updateElementPositions();
				scrollHandler();
			}, 50);
		};

		container.addEventListener('scroll', scrollHandler);
		window.addEventListener('resize', updateElementPositions);

		// 为所有图片添加load事件监听
		this.imageDataMap.forEach((data) => {
			const img = data.element.querySelector('img');
			if (img) {
				img.addEventListener('load', imageLoadHandler, {once: true});
			}
		});

		this.cleanupVirtualScroll = () => {
			resizeObserver.disconnect();
			container.removeEventListener('scroll', scrollHandler);
			window.removeEventListener('resize', updateElementPositions);
		};
	}

	private sortImages(sortType: string) {
		const container = this.contentEl.querySelector('.image-wall');
		if (!container) return;

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
		// 首先更新所有图片的显示状态
		this.imageDataMap.forEach((data) => {
			const imagePath = data.path;
			const isRemote = imagePath.startsWith('http://') || imagePath.startsWith('https://');

			if (filterType === 'all' || filterType === '全部') {
				data.element.style.display = '';
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

		// 在筛选后更新位置信息，然后再触发滚动处理
		const container = this.contentEl.querySelector('.image-wall-container');
		if (container) {
			// 更新位置信息
			setTimeout(() => {
				this.imageDataMap.forEach((data) => {
					const el = data.element;
					if (el && el.style.display !== 'none') {
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
		const imageDiv = imageWall.createDiv('image-item');
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
		imageDiv.addEventListener('click', () => {
			const currentIndex = this.images.indexOf(imagePath);
			this.createLightboxWithNavigation(currentIndex);
		});

		imageDiv.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			const img = imageDiv.querySelector('img');
			if (img) {
				this.createContextMenu(e, img as HTMLImageElement);
			}
		});
	}

	private async loadLocalImageEnhanced(
		imagePath: string,
		img: HTMLImageElement,
		imageDiv: HTMLElement,
		loadingText: HTMLElement
	): Promise<void> {
		return new Promise((resolve, reject) => {
			log.debug(() => `增强型本地图片加载: ${imagePath}`);

			img.onload = () => {
				log.debug(() => `本地图片加载成功: ${imagePath}`);
				this.handleImageLoadSuccess(img, imageDiv, loadingText, imagePath);

				const imageData = this.imageDataMap.get(imagePath);
				if (imageData) {
					imageData.isLoading = false;
				}

				resolve();
			};

			img.onerror = async (e) => {
				log.error(() => `本地图片加载失败 (${img.src}): ${imagePath}`);

				try {
					const alternativePaths = await this.plugin.imageLoader.getAlternativeLocalPaths(imagePath);
					for (const path of alternativePaths) {
						log.debug(() => `尝试替代路径: ${path}`);

						const success = await this.plugin.imageLoader.loadLocalImage(path, img);
						if (success) {
							// 加载成功，等待onload事件处理
							return;
						}
					}

					this.handleImageError(imageDiv, '找不到图片');
					this.loadedImages++;
					this.updateProgressBar();

					// 更新图片数据状态
					const imageData = this.imageDataMap.get(imagePath);
					if (imageData) {
						imageData.hasError = true;
						imageData.isLoading = false;
					}

					reject(e);
				} catch (error) {
					log.error(() => `处理替代路径时出错:`, error);

					// 显示错误
					this.handleImageError(imageDiv, '处理失败');
					this.loadedImages++;
					this.updateProgressBar();

					const imageData = this.imageDataMap.get(imagePath);
					if (imageData) {
						imageData.hasError = true;
						imageData.isLoading = false;
					}

					reject(error);
				}
			};

			this.plugin.imageLoader.loadLocalImage(imagePath, img)
				.then(success => {
					if (!success) {
						// 如果加载失败，回退到标准方法
						img.src = this.plugin.imageLoader.getResourcePath(imagePath);
					}
				})
				.catch(error => {
					log.error(() => `加载器加载失败，回退到标准方法: ${imagePath}`, error);
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
		reject: (error: any) => void,
		isWeiboImage: boolean = false
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
							setTimeout(() => imgReject(new Error('Timeout')), 10000);
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
			log.error(() => `高级加载尝试失败: ${imagePath}`, error);

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
		reject: (error: any) => void,
		isWeiboImage: boolean = false
	): Promise<void> {
		try {
			const controller = new AbortController();
			// 减少超时时间
			const timeoutId = setTimeout(() => controller.abort(), 2000);

			const fetchOptions: RequestInit = {
				method: 'GET',
				credentials: 'omit',
				cache: 'no-cache',
				signal: controller.signal,
				headers: {
					'Cache-Control': 'no-cache',
					'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
					'Referer': isWeiboImage ? 'https://weibo.com/' : 'https://obsidian.md/',
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
				},
				mode: isWeiboImage ? 'no-cors' : undefined
			};

			const response = await fetch(imagePath, fetchOptions);
			clearTimeout(timeoutId);

			if (!response.ok && !isWeiboImage) { // no-cors 模式下无法检查状态
				throw new Error(`HTTP error: ${response.status}`);
			}

			const blob = await response.blob();
			const objectUrl = this.resourceManager.createObjectURL(imagePath, blob);

			img.onload = () => {
				this.handleImageLoadSuccess(img, imageDiv, loadingText, imagePath);

				resolve();
			};

			img.onerror = (e) => {
				log.error(() => `从objectURL加载图片失败:${imagePath}`);
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
				const contentType = blob.type || response.headers.get('content-type') || 'image/jpeg';
				const etag = response.headers.get('etag');

				log.debug(() => `正在缓存图片: ${imagePath}, 类型: ${contentType}`);

				const arrayBuffer = await blob.arrayBuffer();

				try {
					await this.plugin.imageCacheService.cacheImage(
						imagePath,
						arrayBuffer,
						etag || undefined,
						contentType
					);
					log.debug(() => `成功缓存图片: ${imagePath}`);
				} catch (cacheError) {
					log.error(() => `缓存图片失败: ${imagePath}`, cacheError);
				}
			} catch (error) {
				log.error(() => '缓存图片过程中出错:', error);
			}
		} catch (error) {
			log.error(() => `自定义fetch加载失败: ${imagePath}`, error);
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
		reject: (error: any) => void,
		isWeiboImage: boolean = false
	): void {
		log.debug(() => `直接加载图片: ${imagePath}`);

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
					log.error(() => `无法创建canvas上下文用于缓存: ${imagePath}`);
					return;
				}

				// 绘制图片到画布
				ctx.drawImage(imageElement, 0, 0);

				// 将画布内容转换为Blob
				canvas.toBlob(async (blob) => {
					if (!blob) {
						log.error(() => `无法从画布创建Blob: ${imagePath}`);
						return;
					}

					try {
						log.debug(() => `从直接加载的图片创建缓存: ${imagePath}, 大小: ${Math.round(blob.size / 1024)}KB`);

						// 转换为ArrayBuffer
						const arrayBuffer = await blob.arrayBuffer();

						// 调用缓存服务
						await this.plugin.imageCacheService.cacheImage(
							imagePath,
							arrayBuffer,
							undefined,
							blob.type || 'image/jpeg'
						);

						log.debug(() => `成功缓存直接加载的图片: ${imagePath}`);
					} catch (error) {
						log.error(() => `缓存直接加载的图片失败: ${imagePath}, 错误: ${error.message}`, error);
					}
				}, 'image/jpeg', 0.95); // 使用JPEG格式，95%质量
			} catch (error) {
				log.error(() => `设置图片缓存时出错: ${imagePath}`, error);
			}
		};

		img.onload = () => {
			log.debug(() => `图片直接加载成功: ${imagePath}`);
			this.handleImageLoadSuccess(img, imageDiv, loadingText, imagePath);

			// 图片加载成功后尝试缓存
			setupCaching(img);

			resolve();
		};

		img.onerror = (e) => {
			log.error(() => `图片直接加载失败: ${imagePath}, 错误: ${e}`);

			// 对于本地图片尝试替代路径
			if (!imagePath.startsWith('http://') && !imagePath.startsWith('https://')) {
				const alternativePath = this.tryAlternativeLocalPath(imagePath);
				if (alternativePath && alternativePath !== img.src) {
					log.debug(() => `尝试替代路径: ${alternativePath}`);
					img.src = alternativePath;
					return; // 返回等待新路径的加载结果
				}
			}

			this.handleImageError(imageDiv, '加载失败');
			this.loadedImages++;
			this.updateProgressBar();
			reject(e);
		};

		// 如果是微博图片，尝试使用 Obsidian 的 requestUrl API
		if (isWeiboImage) {
			try {
				// 使用 Obsidian 的 requestUrl API 代替 electron.remote
				const {requestUrl} = require('obsidian');

				log.debug(() => `使用 Obsidian requestUrl 加载微博图片: ${imagePath}`);

				requestUrl({
					url: imagePath,
					method: 'GET',
					headers: {
						'Referer': 'https://weibo.com/',
						'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
					}
				}).then(async (response: { arrayBuffer: any; headers: { [x: string]: string; }; }) => {
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
							log.debug(() => `缓存从 requestUrl 获取的微博图片: ${imagePath}, 类型: ${contentType}`);

							await this.plugin.imageCacheService.cacheImage(
								imagePath,
								arrayBuffer,
								undefined,
								contentType
							);

							log.debug(() => `成功缓存微博图片: ${imagePath}`);
						} catch (cacheError) {
							log.error(() => `缓存微博图片失败: ${imagePath}`, cacheError);
						}
					} catch (error) {
						log.error(() => '处理 requestUrl 响应失败:', error);
						img.src = imagePath; // 失败时尝试直接设置
					}
				}).catch((error: Error | undefined) => {
					log.error(() => `requestUrl 加载微博图片失败: ${imagePath}`, error);
					img.src = imagePath; // 失败时尝试直接设置
				});

				return; // 等待 requestUrl 结果
			} catch (e) {
				log.debug(() => `requestUrl 不可用，直接设置src: ${e}`);
			}
		}

		// 所有其他情况：直接设置src
		if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
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
				log.error(() => `解析本地图片路径失败: ${imagePath}`, error);
				this.handleImageError(imageDiv, '找不到图片');
				this.loadedImages++;
				this.updateProgressBar();
				reject(error);
			}
		}
	}

	private isObsidianResourcePath(path: string): boolean {
		// Obsidian资源路径通常包含_resources或_attachments目录
		return path.includes('/_resources/') ||
			path.includes('/_attachments/') ||
			path.includes('/_assets/') ||
			path.match(/\/[^\/]+\/[^\/]+\.(png|jpg|jpeg|gif|svg|webp)$/i) !== null;
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
			log.error(() => '尝试替代路径失败:', error);
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
		log.debug(() => `图片加载成功处理: ${imagePath}, 宽度: ${img.naturalWidth}, 高度: ${img.naturalHeight}`);

		if (loadingText && loadingText.parentNode) {
			loadingText.remove();
		}

		// 移除占位符
		const placeholder = imageDiv.querySelector('.image-placeholder');
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

		imageDiv.style.gridRowEnd = `span ${heightSpan}`;

		// 强制设置图片可见
		img.style.opacity = '1';
		img.setAttribute('complete', 'true');
		img.classList.add('loaded');

		img.offsetHeight; // 触发重绘

		// 确保样式被应用（额外保障）
		setTimeout(() => {
			if (img.style.opacity !== '1') {
				log.debug(() => `修复延迟显示: ${imagePath}`);
				img.style.opacity = '1';
				img.classList.add('loaded');

				// 触发父元素重新计算布局
				if (imageDiv.parentElement) {
					imageDiv.parentElement.style.display = imageDiv.parentElement.style.display;
				}
			}
		}, 50);

		this.loadedImages++;
		this.updateProgressBar();

		const imageData = this.imageDataMap.get(imagePath);
		if (imageData) {
			imageData.isLoading = false;
		}
	}

	private async loadImageUnified(
		imagePath: string,
		img: HTMLImageElement,
		imageDiv: HTMLElement,
		loadingText: HTMLElement,
		isWeiboImage: boolean = false
	): Promise<void> {
		return new Promise(async (resolve, reject) => {
			const imageData = this.imageDataMap.get(imagePath);
			if (!imageData) {
				reject(new Error('Image data not found'));
				return;
			}

			const isNetworkImage = imagePath.startsWith('http://') || imagePath.startsWith('https://');

			// 如果是网络图片，先直接设置原始URL开始加载
			if (isNetworkImage) {
				// 除非是微博图片，否则先尝试直接加载
				if (!isWeiboImage) {
					img.src = imagePath;

					// 设置加载和错误处理
					img.onload = () => {
						this.handleImageLoadSuccess(img, imageDiv, loadingText, imagePath);
						resolve();
						return; // 直接加载成功则提前返回
					};

					// 如果直接加载失败，继续下面的步骤
					img.onerror = (e) => {
						log.error(() => `直接加载网络图片失败: ${imagePath}, 尝试高级加载方式`);
						// 此处不reject，继续尝试其他方法
					};
				}
			}

			try {
				if (this.plugin.settings.enableCache) {
					log.debug(() => `检查图片缓存: ${imagePath}`);

					// 异步获取缓存
					const cachedImage = await this.plugin.imageCacheService.getCachedImage(imagePath);

					if (cachedImage) {
						log.debug(() => `缓存命中，从缓存加载图片: ${imagePath}`);
						loadingText.setText('从缓存加载...');

						const originalOnload = img.onload;
						const originalOnerror = img.onerror;

						img.onload = () => {
							log.debug(() => `缓存图片加载成功: ${imagePath}`);
							this.handleImageLoadSuccess(img, imageDiv, loadingText, imagePath);
							resolve();
						};

						img.onerror = async (e) => {
							log.error(() => `缓存图片加载失败: ${imagePath}, 错误: ${e}`);

							// 恢复原始处理器（如果有的话）
							if (originalOnload) img.onload = originalOnload;
							if (originalOnerror) img.onerror = originalOnerror;

							// 继续尝试下一个方法
							await this.tryAdvancedImageLoading(imagePath, img, imageDiv, loadingText, resolve, reject, isWeiboImage);
						};

						// 设置图片源为缓存的base64数据
						img.src = cachedImage.data;
						return;
					} else {
						log.debug(() => `缓存未命中，将使用其他方式加载: ${imagePath}`);
					}
				} else {
					log.debug(() => `图片缓存已禁用，跳过缓存检查: ${imagePath}`);
				}

				// 如果没有缓存，尝试高级加载方法
				await this.tryAdvancedImageLoading(imagePath, img, imageDiv, loadingText, resolve, reject, isWeiboImage);
			} catch (error) {
				log.error(() => `获取缓存出错: ${imagePath}`, error);

				await this.tryAdvancedImageLoading(imagePath, img, imageDiv, loadingText, resolve, reject, isWeiboImage);
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

		return new Promise<void>(async (resolve, reject) => {
			try {
				// 异步获取缓存
				const cachedImage = await this.plugin.imageCacheService.getCachedImage(imagePath);

				if (cachedImage) {
					log.debug(() => `Loading Weibo image from cache: ${imagePath}`);

					img.onload = () => {
						this.handleImageLoadSuccess(img, imageDiv, loadingText, imagePath);
						resolve();
					};

					img.onerror = async (e) => {
						log.error(() => `Cached Weibo image load error: ${e}`);
						await this.loadWeiboImageWithoutCache(imagePath, img, imageDiv, loadingText, retryCount, resolve, reject);
					};

					// 设置图片源为缓存的base64数据
					img.src = cachedImage.data;
					return;
				}

				await this.loadWeiboImageWithoutCache(imagePath, img, imageDiv, loadingText, retryCount, resolve, reject);
			} catch (error) {
				const currentRequestId = imageDiv.getAttribute('data-request-id');
				this.handleError(error, imageDiv, currentRequestId || undefined, retryCount);
				reject(error);
			}
		});
	}

	private async loadWeiboImageWithoutCache(
		imagePath: string,
		img: HTMLImageElement,
		imageDiv: HTMLElement,
		loadingText: HTMLElement,
		retryCount: number,
		resolve: () => void,
		reject: (error: any) => void
	): Promise<void> {
		// 使用 Obsidian 的 requestUrl API 代替 electron.remote
		const {requestUrl} = require('obsidian');
		const MAX_RETRIES = 3;

		try {
			log.debug(() => `使用 requestUrl 加载微博图片 (无缓存): ${imagePath}`);

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

				const imageData = this.imageDataMap.get(imagePath);
				if (imageData) {
					imageData.isLoading = false;
				}

				resolve();
			};

			img.onerror = async () => {
				if (retryCount < MAX_RETRIES) {
					log.debug(() => `重试微博图片加载 (${retryCount + 1}/${MAX_RETRIES}): ${imagePath}`);
					await this.loadWeiboImage(imagePath, img, imageDiv, loadingText, retryCount + 1);
					resolve();
				} else {
					this.handleImageError(imageDiv, '加载失败');
					this.loadedImages++;
					this.updateProgressBar();
					reject(new Error('达到最大重试次数'));
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
				log.debug(() => `成功缓存微博图片: ${imagePath}`);
			} catch (cacheError) {
				log.error(() => `缓存微博图片失败: ${imagePath}`, cacheError);
			}
		} catch (error) {
			log.error(() => `requestUrl 加载微博图片失败: ${imagePath}`, error);

			const imageData = this.imageDataMap.get(imagePath);
			if (imageData) {
				imageData.isLoading = false;
			}

			if (retryCount < MAX_RETRIES) {
				log.debug(() => `请求失败后重试 (${retryCount + 1}/${MAX_RETRIES}): ${imagePath}`);
				setTimeout(() => {
					this.loadWeiboImage(imagePath, img, imageDiv, loadingText, retryCount + 1)
						.then(resolve)
						.catch(reject);
				}, 1000 * (retryCount + 1));
			} else {
				this.handleImageError(imageDiv, '加载失败');
				this.loadedImages++;
				this.updateProgressBar();
				reject(error);
			}
		}
	}

	private handleError(error: Error, imageDiv: HTMLElement, requestId: string | undefined, retryCount: number) {
		const MAX_RETRIES = 3;

		log.error(() => 'Error loading Weibo image:', error);
		if (requestId) {
			this.currentRequests.delete(requestId);
		}

		if (retryCount < MAX_RETRIES) {
			log.debug(() => `Retrying after error (${retryCount + 1}/${MAX_RETRIES})`);
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

			if (progressText) {
				progressText.setText(`${this.loadedImages}/${this.totalImages}`);
			}

			if (this.loadedImages >= this.totalImages) {
			}
			setTimeout(() => {
				const container = this.contentEl.querySelector('.progress-container');
				if (container) {
					container.addClass('complete');
				}
			}, 800);
		}
	}

	private handleImageError(imageDiv: HTMLElement, message: string) {
		imageDiv.empty();
		imageDiv.addClass('error');
		imageDiv.setText(message);
	}

	private getLinkPath(link: string): string | null {
		try {
			// 如果是直接文件格式，不是Wiki链接
			if (!link.includes('[[') && !link.includes(']]')) {
				// 尝试作为直接文件路径
				const directFile = this.app.vault.getAbstractFileByPath(link);
				if (directFile instanceof TFile) {
					log.debug(() => `找到直接文件路径: ${link}`);
					return directFile.path;
				}

				// 尝试解析为链接路径
				const dest = this.app.metadataCache.getFirstLinkpathDest(link, '');
				if (dest instanceof TFile) {
					log.debug(() => `解析为链接路径: ${dest.path}`);
					return dest.path;
				}

				// 如果是文件名（没有路径），尝试在库中查找
				if (!link.includes('/')) {
					const allFiles = this.app.vault.getFiles();
					const matchedFiles = allFiles.filter(f => f.name === link);
					if (matchedFiles.length > 0) {
						log.debug(() => `通过文件名找到: ${matchedFiles[0].path}`);
						return matchedFiles[0].path;
					}
				}

				// 如果都失败了，尝试添加_resources前缀
				if (!link.startsWith('_resources/')) {
					const resourcePath = `_resources/${link}`;
					const resourceFile = this.app.vault.getAbstractFileByPath(resourcePath);
					if (resourceFile instanceof TFile) {
						log.debug(() => `找到资源文件: ${resourcePath}`);
						return resourceFile.path;
					}
				}

				return link;
			}

			// 处理Wiki链接格式 ![[图片]]
			const stripped = link.replace(/!?\[\[(.*?)]]/, '$1');
			const path = stripped.split('|')[0].trim();

			const file = this.app.metadataCache.getFirstLinkpathDest(path, '');
			if (file instanceof TFile) {
				log.debug(() => `Wiki链接解析为: ${file.path}`);
				return file.path;
			}

			return path;
		} catch (error) {
			log.error(() => 'Error getting link path:', error);
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
			log.error(() => 'Copy failed:', err);
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

			new Notice('正在下载图片');
		} catch (error) {
			log.error(() => '下载失败:', error);
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

			// 预加载相邻图片
			this.preloadAdjacentImages(currentIndex);
		};

		// 初始预加载
		this.preloadAdjacentImages(initialIndex);

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
		this.currentRequests.forEach((request) => {
			try {
				if (request.controller) {
					request.controller.abort();
				} else if (request.electronRequest) {
					request.electronRequest.abort();
				}
			} catch (e) {
				log.error(() => '中止请求时出错:', e);
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

		// 重置状态
		this.loadedImages = 0;
		this.imageDataMap.clear();

		this.contentEl.empty();
	}

}
