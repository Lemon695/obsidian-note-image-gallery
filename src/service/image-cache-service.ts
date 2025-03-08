import {App} from 'obsidian';

interface CachedImage {
	data: string;  // Base64编码的图片数据
	timestamp: number;  // 缓存时间
	etag?: string;  // HTTP ETag用于验证缓存是否有效
}

export class ImageCacheService {
	private cacheKey = 'obsidian-note-image-gallery-cache';
	private maxCacheAge = 7 * 24 * 60 * 60 * 1000;  // 7天缓存过期时间
	private maxCacheSize = 100 * 1024 * 1024;  // 50MB最大缓存大小
	private cache: Record<string, CachedImage> = {};
	private app: App;
	// 回调函数类型
	private shouldUseCacheCallback: (() => boolean) | null = null;

	constructor(app: App) {
		this.app = app;
		this.loadCache();
	}

	/**
	 * 将图片添加到缓存
	 */
	async cacheImage(url: string, data: ArrayBuffer, etag?: string): Promise<string> {
		// 转换为base64
		const base64Data = await this.arrayBufferToBase64(data);

		this.cache[url] = {
			data: base64Data,
			timestamp: Date.now(),
			etag: etag
		};

		this.saveCache();
		return base64Data;
	}

	/**
	 * 从缓存中获取图片
	 */
	getCachedImage(url: string): CachedImage | null {
		const cachedImage = this.cache[url];

		if (!cachedImage) {
			return null;
		}

		// 检查缓存是否过期
		if (Date.now() - cachedImage.timestamp > this.maxCacheAge) {
			delete this.cache[url];
			this.saveCache();
			return null;
		}

		return cachedImage;
	}

	/**
	 * 清除过期缓存和超出大小限制的缓存
	 */
	cleanCache() {
		const now = Date.now();
		let totalSize = 0;
		const urlsByAge: { url: string, timestamp: number }[] = [];

		// 先清除过期缓存
		Object.keys(this.cache).forEach(url => {
			const cachedImage = this.cache[url];
			if (now - cachedImage.timestamp > this.maxCacheAge) {
				delete this.cache[url];
			} else {
				totalSize += cachedImage.data.length * 0.75; // base64编码大约是原始数据的1.33倍，所以这里估算原始大小
				urlsByAge.push({url, timestamp: cachedImage.timestamp});
			}
		});

		// 如果缓存超过最大大小，删除最旧的缓存
		if (totalSize > this.maxCacheSize && urlsByAge.length > 0) {
			// 按时间戳排序
			urlsByAge.sort((a, b) => a.timestamp - b.timestamp);

			// 从最旧的开始删除，直到缓存大小在限制内
			while (totalSize > this.maxCacheSize * 0.8 && urlsByAge.length > 0) {
				const oldest = urlsByAge.shift();
				if (oldest && this.cache[oldest.url]) {
					totalSize -= this.cache[oldest.url].data.length * 0.75;
					delete this.cache[oldest.url];
				}
			}
		}

		this.saveCache();
	}

	/**
	 * 将ArrayBuffer转换为Base64
	 */
	private async arrayBufferToBase64(buffer: ArrayBuffer): Promise<string> {
		// 使用Blob和FileReader进行转换
		return new Promise((resolve, reject) => {
			const blob = new Blob([buffer]);
			const reader = new FileReader();
			reader.onloadend = () => {
				const base64data = reader.result as string;
				resolve(base64data);
			};
			reader.onerror = reject;
			reader.readAsDataURL(blob);
		});
	}

	/**
	 * 保存缓存到本地存储
	 */
	private saveCache() {
		try {
			localStorage.setItem(this.cacheKey, JSON.stringify(this.cache));
		} catch (e) {
			console.error('保存图片缓存失败:', e);

			// 如果存储失败（可能是因为超出localStorage限制），则清除一些缓存
			this.cleanCache();
			try {
				localStorage.setItem(this.cacheKey, JSON.stringify(this.cache));
			} catch (e) {
				console.error('再次保存图片缓存失败，清空缓存:', e);
				this.cache = {};
				localStorage.setItem(this.cacheKey, '{}');
			}
		}
	}

	/**
	 * 从本地存储加载缓存
	 */
	private loadCache() {
		try {
			const cachedData = localStorage.getItem(this.cacheKey);
			if (cachedData) {
				this.cache = JSON.parse(cachedData);
				// 加载缓存后立即清理，移除过期项
				this.cleanCache();
			}
		} catch (e) {
			console.error('加载图片缓存失败:', e);
			this.cache = {};
		}
	}

	/**
	 * 获取缓存大小（字节）
	 */
	getCacheSize(): number {
		let size = 0;
		Object.values(this.cache).forEach(cachedImage => {
			size += cachedImage.data.length * 0.75; // 估算原始大小
		});
		return size;
	}

	/**
	 * 清空所有缓存
	 */
	clearAllCache() {
		this.cache = {};
		this.saveCache();
	}

	/**
	 * 设置最大缓存时间
	 * @param maxAge 最大缓存时间（毫秒）
	 */
	setMaxCacheAge(maxAge: number): void {
		this.maxCacheAge = maxAge;
		this.cleanCache(); // 立即清理可能的过期缓存
	}

	/**
	 * 设置最大缓存大小
	 * @param maxSize 最大缓存大小（字节）
	 */
	setMaxCacheSize(maxSize: number): void {
		this.maxCacheSize = maxSize;
		this.cleanCache(); // 立即清理可能超出大小的缓存
	}

	/**
	 * 检查是否应该使用缓存
	 * 如果缓存被禁用，此方法将返回false
	 */
	shouldUseCache(): boolean {
		if (this.shouldUseCacheCallback) {
			return this.shouldUseCacheCallback();
		}
		return true; // 默认启用缓存
	}

	/**
	 * 设置缓存启用状态检查回调
	 */
	setShouldUseCacheCallback(callback: () => boolean): void {
		this.shouldUseCacheCallback = callback;
	}
}
