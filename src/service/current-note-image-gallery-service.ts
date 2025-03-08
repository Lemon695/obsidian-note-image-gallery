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
	private plugin: NoteImageGalleryPlugin;
	private cleanupQueueMonitor: () => void = () => {
	};

	constructor(app: App, plugin: NoteImageGalleryPlugin, images: string[]) {
		super(app);
		this.images = images;
		this.totalImages = images.length;
		this.plugin = plugin;
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
		const MAX_NON_WEIBO_RETRIES = 5;  // 非微博图片的最大重试次数
		const loadQueue: Array<{ path: string, retries: number }> = [];
		let activeLoads = 0;
		let isProcessingQueue = false;

		const processQueue = async () => {
			if (isProcessingQueue || loadQueue.length === 0 || activeLoads >= MAX_CONCURRENT_LOADS) return;

			isProcessingQueue = true;

			try {
				while (loadQueue.length > 0 && activeLoads < MAX_CONCURRENT_LOADS) {
					const item = loadQueue.shift();
					if (!item) continue;

					const {path, retries} = item;
					const imageData = this.imageDataMap.get(path);

					if (!imageData || imageData.isLoading || imageData.hasError) continue;

					activeLoads++;
					imageData.isLoading = true;

					// 判断图片类型
					const isWeiboImage = path.includes('.sinaimg.cn');
					const isNonWeiboNetworkImage = path.startsWith('http') && !isWeiboImage;
					console.log(`队列处理图片: ${path}, 是否微博图片: ${isWeiboImage}, 是否其他网络图片: ${isNonWeiboNetworkImage}, 当前活跃加载: ${activeLoads}`);

					// 使用 Promise 的方式处理图片加载，确保无论成功或失败都会更新计数
					try {
						if (isWeiboImage) {
							// 特殊处理微博图片
							await new Promise<void>((resolve, reject) => {
								setTimeout(async () => {
									try {
										const imgEl = imageData.element.querySelector('img') || imageData.element.createEl('img');
										const loadingTextEl = imageData.element.querySelector('.loading-text') ||
											imageData.element.createDiv('loading-text');

										await this.loadWeiboImage(
											path,
											imgEl as HTMLImageElement,
											imageData.element,
											loadingTextEl as HTMLElement
										);
										resolve();
									} catch (error) {
										console.error(`微博图片加载失败: ${path}`, error);
										reject(error);
									} finally {
										// 确保减少活跃计数
										activeLoads--;
										imageData.isLoading = false;
										console.log(`微博图片处理完成，当前活跃加载: ${activeLoads}`);
									}
								}, 0);
							});
						} else if (isNonWeiboNetworkImage) {
							// 优化处理非微博网络图片
							await new Promise<void>((resolve, reject) => {
								setTimeout(async () => {
									try {
										const imgEl = imageData.element.querySelector('img') || imageData.element.createEl('img');
										const loadingTextEl = imageData.element.querySelector('.loading-text') ||
											imageData.element.createDiv('loading-text');
										loadingTextEl.setText('加载中...');

										// 先尝试直接加载
										try {
											await this.loadImage(path, imageData.element);
											resolve();
										} catch (error) {
											console.error(`常规加载非微博图片失败，尝试备用方法: ${path}`, error);

											// 如果常规加载失败，尝试使用特殊方法
											try {
												// 尝试使用fetch方法
												const imgEl = imageData.element.querySelector('img') as HTMLImageElement || imageData.element.createEl('img');
												await this.fetchAndLoadImage(path, imgEl);

												// 如果成功，处理成功状态
												this.handleImageLoadSuccess(imgEl, imageData.element, loadingTextEl as HTMLElement, path);
												resolve();
											} catch (fetchError) {
												console.error(`备用方法加载失败: ${path}`, fetchError);

												if (retries < MAX_NON_WEIBO_RETRIES) {
													console.log(`将非微博图片排入重试队列: ${path}, 尝试: ${retries + 1}/${MAX_NON_WEIBO_RETRIES}`);
													loadQueue.push({path, retries: retries + 1});
												} else {
													imageData.hasError = true;
													this.handleImageError(imageData.element, '加载失败');
													this.loadedImages++;
													this.updateProgressBar();
												}
												reject(fetchError);
											}
										}
									} catch (error) {
										console.error(`处理非微博图片失败: ${path}`, error);
										reject(error);
									} finally {
										// 确保减少活跃计数
										activeLoads--;
										imageData.isLoading = false;
										console.log(`非微博网络图片处理完成，当前活跃加载: ${activeLoads}`);
									}
								}, 0);
							});
						} else {
							// 标准图片加载处理（本地图片）
							await new Promise<void>((resolve, reject) => {
								setTimeout(async () => {
									try {
										await this.loadImage(path, imageData.element);
										resolve();
									} catch (error) {
										console.error(`加载图片 ${path} 时出错:`, error);

										if (retries < MAX_RETRIES) {
											console.log(`将图片 ${path} 排队重试 ${retries + 1}/${MAX_RETRIES}`);
											loadQueue.push({path, retries: retries + 1});
										} else {
											imageData.hasError = true;
											this.handleImageError(imageData.element, '加载失败');
											this.loadedImages++;
											this.updateProgressBar();
										}
										reject(error);
									} finally {
										// 确保减少活跃计数
										activeLoads--;
										imageData.isLoading = false;
										console.log(`标准图片处理完成，当前活跃加载: ${activeLoads}`);
									}
								}, 0);
							});
						}
					} catch (error) {
						// 这里处理的是整个 Promise 的失败，可以记录日志但不需要额外操作
						// 因为内部已经处理了 activeLoads 和 imageData.isLoading
						console.error(`图片加载失败处理: ${path}`, error);
					}
				}
			} finally {
				isProcessingQueue = false;

				// 延迟检查队列，确保状态已更新
				setTimeout(() => {
					if (loadQueue.length > 0 && activeLoads < MAX_CONCURRENT_LOADS) {
						processQueue();
					}
				}, 50);
			}
		};

		this.queueImageLoad = (imagePath: string) => {
			const imageData = this.imageDataMap.get(imagePath);
			if (!imageData) return;

			if (!imageData.isLoading && !imageData.hasError &&
				!loadQueue.some(item => item.path === imagePath)) {
				console.log(`将图片加入队列: ${imagePath}, 当前队列长度: ${loadQueue.length}, 当前活跃加载: ${activeLoads}`);
				loadQueue.push({path: imagePath, retries: 0});
				setTimeout(processQueue, 0);
			}
		};

		const queueMonitor = setInterval(() => {
			if (loadQueue.length > 0 || activeLoads > 0) {
				console.log(`队列监控 - 队列长度: ${loadQueue.length}, 活跃加载: ${activeLoads}, 是否处理中: ${isProcessingQueue}`);

				// 如果队列有内容但没有活跃加载，并且未处理中，尝试重启队列处理
				if (loadQueue.length > 0 && activeLoads === 0 && !isProcessingQueue) {
					console.log('队列似乎卡住了，尝试重启处理');
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
				// 如果还没有位置信息，跳过
				if (!data.position) return;

				// 检查是否应该基于筛选条件显示
				const imagePath = data.path;
				const isRemote = imagePath.startsWith('http://') || imagePath.startsWith('https://');
				const matchesFilter =
					currentFilter === '全部' || currentFilter === 'all' ||
					((currentFilter === '本地图片' || currentFilter === 'local') && !isRemote) ||
					((currentFilter === '网络图片' || currentFilter === 'remote') && isRemote);

				// 首先处理筛选条件
				if (!matchesFilter) {
					// 不符合筛选条件，直接隐藏
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
						this.queueImageLoad(data.path);
					}
					data.element.style.visibility = ''; // 显示元素

					const images = Array.from(data.element.querySelectorAll('img'));
					images.forEach(imgEl => {
						if (imgEl.complete && imgEl.naturalWidth > 0 && imgEl.style.opacity !== '1') {
							console.log(`修复未显示的图片: ${data.path}`);
							imgEl.style.opacity = '1';
							imgEl.setAttribute('complete', 'true');
							imgEl.classList.add('loaded');
						}
					});
				} else {
					// 不在可视区域内但符合筛选条件
					// 设置为隐藏但保留在DOM中
					data.element.style.visibility = 'hidden';
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
			const imageData = this.imageDataMap.get(imagePath);
			if (!imageData) {
				reject(new Error('Image data not found'));
				return;
			}

			const cachedImage = this.plugin.imageCacheService.getCachedImage(imagePath);
			if (cachedImage) {
				console.log(`Loading image from cache: ${imagePath}`);

				// 从缓存加载
				img.onload = () => {
					this.handleImageLoadSuccess(img, imageDiv, loadingText, imagePath);
					resolve();
				};

				img.onerror = (e) => {
					console.error('Cached image load error:', e);
					// 缓存加载失败，回退到正常加载
					this.loadImageWithoutCache(imagePath, img, imageDiv, loadingText, resolve, reject);
				};

				// 设置图片源为缓存的base64数据
				img.src = cachedImage.data;
				return;
			}

			// 没有缓存，正常加载图片
			this.loadImageWithoutCache(imagePath, img, imageDiv, loadingText, resolve, reject);
		});
	}

	private loadImageWithoutCache(
		imagePath: string,
		img: HTMLImageElement,
		imageDiv: HTMLElement,
		loadingText: HTMLElement,
		resolve: () => void,
		reject: (error: any) => void
	): void {
		const controller = new AbortController();
		const requestId = Date.now().toString();

		// 保存请求数据
		this.currentRequests.set(requestId, {
			controller,
			timestamp: Date.now()
		});

		imageDiv.setAttribute('data-request-id', requestId);

		// 关键修改：为非微博网络图片添加明确的加载事件处理
		const isNonWeiboNetworkImage = imagePath.startsWith('http') && !imagePath.includes('.sinaimg.cn');

		// 设置图片加载处理程序
		img.onload = () => {
			console.log(`图片加载成功: ${imagePath}`);
			this.handleImageLoadSuccess(img, imageDiv, loadingText, imagePath);
			this.currentRequests.delete(requestId);
			resolve();
		};

		img.onerror = async (e) => {
			console.error('图片加载错误:', imagePath);

			// 如果尚未尝试，先使用 CORS
			if (!img.crossOrigin && (imagePath.startsWith('http://') || imagePath.startsWith('https://'))) {
				console.log('使用 CORS 重试:', imagePath);
				img.crossOrigin = 'anonymous';
				img.src = imagePath;
				return;
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
		};

		// 关键修改：针对非微博网络图片使用专门的加载逻辑
		if (isNonWeiboNetworkImage) {
			console.log(`使用直接加载方式加载非微博网络图片: ${imagePath}`);

			// 创建一个新的Image对象预加载图片
			const preloadImg = new Image();
			preloadImg.crossOrigin = "anonymous";

			preloadImg.onload = () => {
				// 预加载成功后，设置到DOM中的img元素
				console.log(`非微博图片预加载成功: ${imagePath}`);
				img.src = imagePath;
			};

			preloadImg.onerror = () => {
				// 预加载失败，尝试直接设置
				console.log(`非微博图片预加载失败，直接设置src: ${imagePath}`);
				img.src = imagePath;
			};

			// 开始预加载
			preloadImg.src = imagePath;
		} else if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
			// 对于微博图片和其他特殊网络图片，继续使用原有的缓存方法
			this.fetchAndCacheImage(imagePath, img);
		} else {
			// 本地图片处理
			const realPath = this.getLinkPath(imagePath);
			if (!realPath) {
				this.handleImageError(imageDiv, '找不到图片');
				this.loadedImages++;
				this.updateProgressBar();

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
	}

	private async fetchAndLoadImage(imagePath: string, img: HTMLImageElement): Promise<void> {
		try {
			// 设置较短的超时时间
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 10000);

			// 使用 fetch 加载图片并创建 objectURL 直接显示
			const response = await fetch(imagePath, {
				method: 'GET',
				credentials: 'omit',  // 不发送凭证
				cache: 'no-cache',    // 不使用缓存
				signal: controller.signal,
				headers: {
					'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
					'Cache-Control': 'no-cache',
					// 添加一些常见的请求头，模拟浏览器行为
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
				}
			});

			clearTimeout(timeoutId);

			if (!response.ok) {
				throw new Error(`HTTP error: ${response.status}`);
			}

			// 获取图片数据并创建 blob URL
			const blob = await response.blob();
			const objectUrl = URL.createObjectURL(blob);

			// 记录创建的对象 URL 以便后续清理
			img.setAttribute('data-object-url', objectUrl);
			img.src = objectUrl;

			// 尝试在后台异步缓存图片，但不等待这个过程
			this.tryToStoreImageInCache(imagePath, blob).catch(e => {
				console.log('图片缓存失败(不影响显示):', e);
			});

		} catch (error) {
			console.error('Fetch加载图片失败:', error);
			throw error;  // 重新抛出错误以便调用者处理
		}
	}

// 辅助方法：尝试将图片存入缓存
	private async tryToStoreImageInCache(imagePath: string, blob: Blob): Promise<void> {
		try {
			// 转换 blob 为 arrayBuffer
			const arrayBuffer = await blob.arrayBuffer();

			// 根据图片类型确定 MIME 类型
			let mimeType = 'image/jpeg';  // 默认类型
			if (imagePath.toLowerCase().endsWith('.png')) {
				mimeType = 'image/png';
			} else if (imagePath.toLowerCase().endsWith('.gif')) {
				mimeType = 'image/gif';
			} else if (imagePath.toLowerCase().endsWith('.webp')) {
				mimeType = 'image/webp';
			} else if (imagePath.toLowerCase().endsWith('.svg')) {
				mimeType = 'image/svg+xml';
			}

			// 将图片数据存入缓存服务
			await this.plugin.imageCacheService.cacheImage(
				imagePath,
				arrayBuffer,
				undefined,  // 没有 ETag
				mimeType
			);

			console.log('图片成功缓存:', imagePath);
		} catch (error) {
			console.error('存储图片到缓存失败:', error);
			throw error;
		}
	}

	private async fetchAndCacheImage(imagePath: string, img: HTMLImageElement): Promise<void> {
		try {
			// 使用fetch API获取图片
			const response = await fetch(imagePath, {
				method: 'GET',
				credentials: 'omit',
				cache: 'no-cache',
				headers: {
					'Cache-Control': 'no-cache',
				}
			});

			if (!response.ok) {
				throw new Error(`HTTP error: ${response.status}`);
			}

			// 获取ETag用于缓存验证和MIME类型
			const etag = response.headers.get('etag') || undefined;
			const contentType = response.headers.get('content-type') || undefined;
			const arrayBuffer = await response.arrayBuffer();

			// 传递MIME类型到缓存服务
			const base64Data = await this.plugin.imageCacheService.cacheImage(
				imagePath,
				arrayBuffer,
				etag,
				contentType || undefined
			);

			img.src = base64Data;
		} catch (error) {
			console.error('Fetching image failed:', error);
			// 如果获取失败，回退到直接设置src
			img.src = imagePath;
		}
	}

	private handleImageLoadSuccess(img: HTMLImageElement, imageDiv: HTMLElement, loadingText: HTMLElement, imagePath: string): void {
		console.log(`处理图片加载成功: ${imagePath}, 宽度: ${img.naturalWidth}, 高度: ${img.naturalHeight}`);

		// 安全移除加载文本
		if (loadingText && loadingText.parentNode) {
			loadingText.remove();
		}

		// 移除占位符
		const placeholder = imageDiv.querySelector('.image-placeholder');
		if (placeholder) {
			placeholder.remove();
		}

		// 确保图片有有效尺寸
		let ratio = 1;
		if (img.naturalWidth > 0 && img.naturalHeight > 0) {
			ratio = img.naturalHeight / img.naturalWidth;
		}

		const baseHeight = 10;
		const heightSpan = Math.min(Math.ceil(ratio * baseHeight), 30);

		imageDiv.style.gridRowEnd = `span ${heightSpan}`;

		// 关键修改：确保图片可见
		img.style.opacity = '1';

		// 添加调试信息
		console.log(`图片设置完成 - ${imagePath}，opacity: ${img.style.opacity}, grid span: ${heightSpan}`);

		this.loadedImages++;
		this.updateProgressBar();

		const imageData = this.imageDataMap.get(imagePath);
		if (imageData) {
			imageData.isLoading = false;
		}
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
				const cachedImage = this.plugin.imageCacheService.getCachedImage(imagePath);
				if (cachedImage) {
					console.log(`Loading Weibo image from cache: ${imagePath}`);

					img.onload = () => {
						this.handleImageLoadSuccess(img, imageDiv, loadingText, imagePath);
						resolve();
					};

					img.onerror = async (e) => {
						console.error('Cached Weibo image load error:', e);
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
		const electron = require('electron');
		if (!electron || !electron.remote || !electron.remote.net) {
			console.error('Electron API 不可用');
			// 回退到标准方式加载
			img.src = imagePath;

			// 确保更新图片数据状态
			const imageData = this.imageDataMap.get(imagePath);
			if (imageData) {
				imageData.isLoading = false;
			}

			reject(new Error('Electron API 不可用'));
			return;
		}

		const {net} = require('electron').remote;
		const MAX_RETRIES = 3;

		// 创建新请求前检查并清理旧请求
		const existingRequestId = imageDiv.getAttribute('data-request-id');
		if (existingRequestId) {
			const oldRequest = this.currentRequests.get(existingRequestId);
			if (oldRequest) {
				if (oldRequest.electronRequest) {
					try {
						oldRequest.electronRequest.abort(); // Abort Electron request
					} catch (e) {
						console.error('Failed to abort Electron request:', e);
					}
				} else if (oldRequest.controller) {
					oldRequest.controller.abort(); // Abort fetch request
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

		const requestId = Date.now().toString();
		imageDiv.setAttribute('data-request-id', requestId);

		this.currentRequests.set(requestId, {
			electronRequest: request,
			timestamp: Date.now()
		});

		const imageData: Buffer[] = [];

		request.on('response', (response: any) => {
			if (response.statusCode !== 200) {
				reject(new Error(`HTTP Error: ${response.statusCode}`));
				return;
			}

			response.on('data', (chunk: Buffer) => {
				imageData.push(chunk);
			});

			response.on('end', async () => {
				try {
					const buffer = Buffer.concat(imageData);
					const blob = new Blob([buffer]);

					// 清理旧的 objectURL
					const oldObjectUrl = imageDiv.getAttribute('data-object-url');
					if (oldObjectUrl) {
						URL.revokeObjectURL(oldObjectUrl);
					}

					// 尝试从响应头获取内容类型
					const contentType = response.headers['content-type'];

					// 传递内容类型到缓存服务
					await this.plugin.imageCacheService.cacheImage(
						imagePath,
						buffer.buffer,
						undefined,
						contentType
					);

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
					reject(error);
				}
			});
		});

		request.on('error', (error: Error) => {
			console.error(`微博图片请求错误: ${imagePath}`, error);
			this.handleError(error, imageDiv, requestId, retryCount);

			// 确保更新图片数据状态
			const imageData = this.imageDataMap.get(imagePath);
			if (imageData) {
				imageData.isLoading = false;
			}

			reject(error);
		});

		const timeoutId = setTimeout(() => {
			console.warn(`微博图片请求超时: ${imagePath}`);
			try {
				request.abort();
			} catch (e) {
				console.error('中止超时请求时出错:', e);
			}
			this.currentRequests.delete(requestId);

			// 确保更新图片数据状态
			const imageData = this.imageDataMap.get(imagePath);
			if (imageData) {
				imageData.isLoading = false;
			}

			if (retryCount < MAX_RETRIES) {
				console.log(`超时后重试加载微博图片 (${retryCount + 1}/${MAX_RETRIES}): ${imagePath}`);
				this.loadWeiboImage(imagePath, img, imageDiv, loadingText, retryCount + 1)
					.then(resolve)
					.catch(reject);
			} else {
				this.handleImageError(imageDiv, '请求超时');
				this.loadedImages++;
				this.updateProgressBar();
				reject(new Error('Request timeout'));
			}
		}, 5000);

		request.end();
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
