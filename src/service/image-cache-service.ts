import {App, TFile, Vault} from 'obsidian';
import {log} from "../utils/log-utils";

interface CachedImage {
	data: string;  // Base64编码的图片数据
	timestamp: number;  // 缓存时间
	etag?: string;  // HTTP ETag用于验证缓存是否有效
}

interface CacheIndex {
	[url: string]: {
		timestamp: number;
		etag?: string;
		filename: string;
		size: number;
		accessCount?: number;  // 访问计数
		lastAccessed?: number; // 最后访问时间
		score?: number;
	}
}

export class ImageCacheService {
	private cacheDir = '.obsidian/plugins/note-image-gallery/cache';
	private indexFile = '.obsidian/plugins/note-image-gallery/cache/index.json';
	private maxCacheAge = 7 * 24 * 60 * 60 * 1000;  // 7天缓存过期时间
	private maxCacheSize = 100 * 1024 * 1024;  // 100MB最大缓存大小
	private cacheIndex: CacheIndex = {};
	private app: App;
	private shouldUseCacheCallback: (() => boolean) | null = null;
	private _isSaving: boolean = false;
	private totalCacheSize: number = 0;
	private debounceSaveTimeout: NodeJS.Timeout | null = null;

	constructor(app: App) {
		this.app = app;
		this.loadCacheIndex();
	}

	/**
	 * 初始化缓存目录
	 */
	private async ensureCacheDir() {
		try {
			const adapter = this.app.vault.adapter;

			// 检查并创建插件目录
			const pluginDir = '.obsidian/plugins/note-image-gallery';
			if (!(await adapter.exists(pluginDir))) {
				log.debug(() => `创建插件目录: ${pluginDir}`);
				await adapter.mkdir(pluginDir);
			}

			// 检查并创建缓存目录
			if (!(await adapter.exists(this.cacheDir))) {
				log.debug(() => `创建缓存目录: ${this.cacheDir}`);
				await adapter.mkdir(this.cacheDir);
			}

			// 验证目录是否已创建成功
			if (!(await adapter.exists(this.cacheDir))) {
				throw new Error(`无法验证缓存目录是否创建成功: ${this.cacheDir}`);
			}

			log.debug(() => `缓存目录已确认: ${this.cacheDir}`);
			return true;
		} catch (error) {
			log.error(() => `确保缓存目录存在时出错:`, error);
			throw error; // 重新抛出错误以便调用者知道操作失败
		}
	}

	public async initCache(): Promise<void> {
		try {
			await this.ensureCacheDir();
			await this.loadCacheIndex();
			await this.cleanupOrphanedFiles();
			log.debug(() => `缓存服务初始化完成，总大小: ${Math.round(this.totalCacheSize / 1024 / 1024)}MB`);
		} catch (error) {
			log.error(() => `缓存服务初始化失败:`, error);
			// 确保基本的缓存功能可用
			this.cacheIndex = {};
			this.totalCacheSize = 0;
		}
	}

	/**
	 * 加载缓存索引
	 */
	private async loadCacheIndex() {
		await this.ensureCacheDir();

		const adapter = this.app.vault.adapter;
		const exists = await adapter.exists(this.indexFile);

		if (exists) {
			try {
				const content = await adapter.read(this.indexFile);
				this.cacheIndex = JSON.parse(content);

				// 计算总缓存大小
				this.totalCacheSize = 0;
				Object.values(this.cacheIndex).forEach(entry => {
					this.totalCacheSize += entry.size;
				});

				log.debug(() => `已加载缓存索引，共 ${Object.keys(this.cacheIndex).length} 项，总大小 ${Math.round(this.totalCacheSize / 1024 / 1024)}MB`);

				// 检查缓存文件是否实际存在
				await this.validateCacheFiles();

				// 加载后清理过期缓存
				await this.cleanCache();
			} catch (e) {
				log.error(() => `加载缓存索引失败:`, e);
				this.cacheIndex = {};
				this.totalCacheSize = 0;
			}
		} else {
			this.cacheIndex = {};
			this.totalCacheSize = 0;
			await this.saveCacheIndex();
		}
	}

	/**
	 * 验证缓存文件是否实际存在，移除不存在的缓存索引
	 */
	private async validateCacheFiles(): Promise<void> {
		const adapter = this.app.vault.adapter;
		const invalidUrls: string[] = [];

		for (const url in this.cacheIndex) {
			const entry = this.cacheIndex[url];
			const filePath = `${this.cacheDir}/${entry.filename}`;

			const exists = await adapter.exists(filePath);
			if (!exists) {
				invalidUrls.push(url);
				this.totalCacheSize -= entry.size;
				log.debug(() => `缓存文件不存在，从索引中移除: ${url}`);
			}
		}

		// 从索引中移除不存在的文件
		invalidUrls.forEach(url => {
			delete this.cacheIndex[url];
		});

		if (invalidUrls.length > 0) {
			log.debug(() => `移除了 ${invalidUrls.length} 个无效的缓存项`);
			await this.saveCacheIndex();
		}
	}

	/**
	 * 保存缓存索引
	 */
	public async saveCacheIndex() {
		if (this._isSaving) {
			log.debug(() => `缓存索引正在保存中，跳过重复调用`);
			return;
		}

		this._isSaving = true;
		let retries = 0;
		const maxRetries = 3;

		log.debug(() => `开始保存缓存索引，条目数: ${Object.keys(this.cacheIndex).length}`);

		while (retries < maxRetries) {
			try {
				// 确保缓存目录存在
				await this.ensureCacheDir();

				// 准备JSON数据
				const jsonData = JSON.stringify(this.cacheIndex, null, 2); // 使用格式化的JSON便于检查

				// 写入文件
				const adapter = this.app.vault.adapter;
				await adapter.write(this.indexFile, jsonData);

				log.debug(() => `缓存索引保存成功，大小: ${Math.round(jsonData.length / 1024)}KB`);
				break;
			} catch (e) {
				retries++;
				log.error(() => `保存缓存索引失败 (尝试 ${retries}/${maxRetries}):`, e);

				if (retries >= maxRetries) {
					log.error(() => `达到最大重试次数，无法保存缓存索引`);
					break;
				}

				// 等待短暂时间后重试
				const delay = 500 * retries;
				log.debug(() => `${delay}ms后重试保存缓存索引`);
				await new Promise(resolve => setTimeout(resolve, delay));
			}
		}

		this._isSaving = false;
	}

	/**
	 * 将图片添加到缓存
	 */
	async cacheImage(url: string, data: ArrayBuffer, etag?: string, mimeType?: string): Promise<string> {
		log.debug(() => `请求缓存图片: ${url}, 大小: ${Math.round(data.byteLength / 1024)}KB, 类型: ${mimeType || '未知'}`);

		if (!data || data.byteLength === 0) {
			log.error(() => `跳过缓存图片 ${url}: 数据无效或为空`);
			return this.arrayBufferToBase64(data);
		}

		// 检查是否应该缓存此图片
		if (!this.shouldCacheImage(url, mimeType)) {
			log.debug(() => `跳过缓存图片 ${url}: 缓存条件不满足`);
			return await this.arrayBufferToBase64(data);
		}

		// 检查数据大小，过大的图片不缓存
		const MAX_SINGLE_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB单图片上限
		if (data.byteLength > MAX_SINGLE_IMAGE_SIZE) {
			log.debug(() => `跳过缓存图片 ${url}: 图片过大 (${Math.round(data.byteLength / 1024)}KB)`);
			return await this.arrayBufferToBase64(data);
		}

		// 转换为base64用于返回（在任何情况下都需要返回）
		const base64Data = await this.arrayBufferToBase64(data);

		try {
			// 确保缓存目录存在
			const dirExists = await this.ensureCacheDir();
			if (!dirExists) {
				throw new Error("无法确保缓存目录存在");
			}

			// 生成文件名
			const filename = this.generateFilename(url);
			const filePath = `${this.cacheDir}/${filename}`;

			log.debug(() => `写入缓存文件: ${filePath}, 大小: ${Math.round(data.byteLength / 1024)}KB`);

			const dataArray = new Uint8Array(data);

			// 先写入文件，确保成功
			await this.app.vault.adapter.writeBinary(filePath, dataArray);

			const fileExists = await this.app.vault.adapter.exists(filePath);
			if (!fileExists) {
				throw new Error(`缓存文件写入后验证失败: ${filePath}`);
			}

			// 文件写入成功后再更新索引
			this.cacheIndex[url] = {
				timestamp: Date.now(),
				etag: etag,
				filename: filename,
				size: data.byteLength
			};

			// 更新总缓存大小
			this.totalCacheSize += data.byteLength;

			if (this.totalCacheSize > this.maxCacheSize) {
				await this.cleanCache();
			}

			// 保存索引
			this.debouncedSaveCacheIndex(5000);  // 使用已有的防抖方法，5秒后保存

			log.debug(() => `成功缓存图片: ${url}, 总缓存大小: ${Math.round(this.totalCacheSize / 1024 / 1024)}MB`);
		} catch (error) {
			log.error(() => `缓存图片 ${url} 失败:`, error);
		}

		return base64Data;
	}

	/**
	 * 从缓存中获取图片
	 */
	async getCachedImage(url: string): Promise<CachedImage | null> {
		log.debug(() => `检查缓存: ${url}`);

		// 首先检查缓存是否启用
		if (!this.shouldUseCache()) {
			log.debug(() => `缓存未启用，跳过检查: ${url}`);
			return null;
		}

		const cacheEntry = this.cacheIndex[url];

		if (!cacheEntry) {
			log.debug(() => `缓存未命中: ${url}`);
			return null;
		}

		// 检查缓存是否过期
		if (Date.now() - cacheEntry.timestamp > this.maxCacheAge) {
			log.debug(() => `缓存已过期: ${url}, 时间: ${new Date(cacheEntry.timestamp).toLocaleString()}`);
			await this.removeCacheEntry(url);
			return null;
		}

		try {
			const filePath = `${this.cacheDir}/${cacheEntry.filename}`;
			log.debug(() => `读取缓存文件: ${filePath}`);

			// 检查文件是否存在
			const exists = await this.app.vault.adapter.exists(filePath);
			if (!exists) {
				log.warn(() => `缓存索引存在但文件不存在: ${filePath}`);
				await this.removeCacheEntry(url);
				return null;
			}

			// 读取缓存文件
			const arrayBuffer = await this.app.vault.adapter.readBinary(filePath);
			log.debug(() => `读取缓存成功: ${url}, 大小: ${Math.round(arrayBuffer.byteLength / 1024)}KB`);

			const base64Data = await this.arrayBufferToBase64(arrayBuffer);

			// 更新访问统计信息
			cacheEntry.accessCount = (cacheEntry.accessCount || 0) + 1;
			cacheEntry.lastAccessed = Date.now();

			// 使用防抖保存索引，避免频繁写入
			this.debouncedSaveCacheIndex();

			return {
				data: base64Data,
				timestamp: cacheEntry.timestamp,
				etag: cacheEntry.etag
			};
		} catch (e) {
			log.error(() => `读取缓存图片 ${url} 失败:`, e);
			await this.removeCacheEntry(url);
			return null;
		}
	}

	// 添加防抖保存索引方法
	private debouncedSaveCacheIndex(delay: number = 2000): void {
		if (this.debounceSaveTimeout) {
			clearTimeout(this.debounceSaveTimeout);
		}

		this.debounceSaveTimeout = setTimeout(() => {
			this.saveCacheIndex().catch(e => {
				log.error(() => `延迟保存缓存索引失败:`, e);
			});
			this.debounceSaveTimeout = null;
		}, delay);
	}

	/**
	 * 清除过期缓存和超出大小限制的缓存
	 */
	async cleanCache() {
		const now = Date.now();
		let removedCount = 0;
		let freedSpace = 0;

		// 步骤1: 删除过期缓存
		for (const url of Object.keys(this.cacheIndex)) {
			const entry = this.cacheIndex[url];
			if (now - entry.timestamp > this.maxCacheAge) {
				const size = entry.size;
				await this.removeCacheEntry(url);
				removedCount++;
				freedSpace += size;
			}
		}

		// 如果缓存仍然超过最大大小，需要进一步清理
		if (this.totalCacheSize > this.maxCacheSize) {
			// 收集有效缓存项
			const validEntries = Object.entries(this.cacheIndex).map(([url, entry]) => ({
				url,
				timestamp: entry.timestamp,
				size: entry.size,
				accessCount: entry.accessCount || 0,
				lastAccessed: entry.lastAccessed || entry.timestamp,
				score: 0
			}));

			// 计算优先级分数 (较低的分数会先被删除)
			// LFU+LRU混合算法
			validEntries.forEach(entry => {
				const daysSinceAccess = (now - entry.lastAccessed) / (1000 * 60 * 60 * 24);
				const daysSinceCreation = (now - entry.timestamp) / (1000 * 60 * 60 * 24);

				// 频率得分：使用对数避免极端值
				const frequencyScore = Math.log2(entry.accessCount + 1) * 15;

				// 时效得分：使用指数衰减
				const recencyScore = Math.exp(-daysSinceAccess / 7) * 25; // 7天半衰期

				// 大小惩罚：平方根增长
				const sizeMB = entry.size / (1024 * 1024);
				const sizePenalty = Math.sqrt(sizeMB) * 4;

				// 年龄惩罚：缓存时间越久，价值越低
				const agePenalty = Math.min(15, daysSinceCreation / 3);

				entry['score'] = frequencyScore + recencyScore - sizePenalty - agePenalty;
			});

			// 按分数排序 (低分优先删除)
			validEntries.sort((a, b) => a['score'] - b['score']);

			// 计算需要释放的空间
			let spaceToFree = this.totalCacheSize - (this.maxCacheSize * 0.8); // 释放到80%
			log.debug(() => `缓存超过限制，需要释放 ${Math.round(spaceToFree / 1024 / 1024)}MB 空间, 根据优先级`);

			// 从低分开始删除，直到释放足够空间
			for (const entry of validEntries) {
				if (spaceToFree <= 0) break;

				log.debug(() => `删除低优先级缓存: ${entry.url}, 分数: ${entry['score']}, 大小: ${Math.round(entry.size / 1024)}KB`);
				await this.removeCacheEntry(entry.url);

				freedSpace += entry.size;
				spaceToFree -= entry.size;
				removedCount++;
			}
		}

		if (removedCount > 0) {
			log.debug(() => `缓存清理完成: 删除了 ${removedCount} 项，释放了 ${Math.round(freedSpace / 1024 / 1024)}MB 空间`);
			await this.saveCacheIndex();
		}
	}

	/**
	 * 移除单个缓存项
	 */
	private async removeCacheEntry(url: string) {
		try {
			const entry = this.cacheIndex[url];
			if (!entry) return;

			const filePath = `${this.cacheDir}/${entry.filename}`;

			// 检查文件是否存在
			const exists = await this.app.vault.adapter.exists(filePath);
			if (exists) {
				await this.app.vault.adapter.remove(filePath);
			}

			// 更新总缓存大小
			this.totalCacheSize -= entry.size;

			// 从索引中删除
			delete this.cacheIndex[url];
		} catch (e) {
			log.error(() => `移除缓存项 ${url} 失败:`, e);
		}
	}

	/**
	 * 生成缓存文件名
	 */
	private generateFilename(url: string): string {
		// 使用URL的哈希值作为文件名
		const hash = this.hashString(url);

		// 从URL获取可能的文件扩展名
		let ext = this.getFileExtension(url);
		if (!ext) ext = 'dat';

		return `${hash}.${ext}`;
	}

	/**
	 * 计算字符串的哈希值
	 */
	private hashString(str: string): string {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const char = str.charCodeAt(i);
			hash = ((hash << 5) - hash) + char;
			hash = hash & hash; // 转换为32位整数
		}
		return Math.abs(hash).toString(16);
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
	 * 获取URL的文件扩展名
	 */
	private getFileExtension(url: string): string {
		try {
			// 移除URL中的查询参数和片段标识
			const urlWithoutParams = url.split('?')[0].split('#')[0];

			// 从URL路径中提取文件名部分（最后一个/之后的内容）
			const pathParts = urlWithoutParams.split('/');
			const filename = pathParts[pathParts.length - 1];

			// 从文件名中提取扩展名（最后一个.之后的内容）
			const dotIndex = filename.lastIndexOf('.');
			if (dotIndex > 0 && dotIndex < filename.length - 1) {
				const ext = filename.substring(dotIndex + 1).toLowerCase();
				// 确保扩展名不包含特殊字符（只允许字母和数字）
				if (/^[a-z0-9]+$/i.test(ext)) {
					return ext;
				}
			}

			// 特殊处理：Twitter图片URL可能通过查询参数指定格式
			// 例如：?format=jpg 或 ?format=png
			if (url.includes('format=')) {
				const formatMatch = url.match(/format=([a-z]+)/i);
				if (formatMatch && formatMatch[1]) {
					const format = formatMatch[1].toLowerCase();
					if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(format)) {
						return format === 'jpg' ? 'jpeg' : format;
					}
				}
			}
		} catch (e) {
			log.error(() => `Error extracting file extension:`, e);
		}
		return '';
	}

	/**
	 * 检查MIME类型是否为静态图片
	 */
	private isStaticImageMimeType(mimeType: string): boolean {
		const staticImageMimeTypes = [
			'image/jpeg',
			'image/png',
			'image/webp',
			'image/bmp',
			'image/tiff',
			'image/svg+xml'
		];
		return staticImageMimeTypes.includes(mimeType.toLowerCase());
	}

	/**
	 * 检查文件扩展名是否为静态图片
	 */
	private isStaticImageExtension(extension: string): boolean {
		const staticImageExtensions = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tiff', 'tif', 'svg'];
		return staticImageExtensions.includes(extension.toLowerCase());
	}

	/**
	 * 检查是否应该缓存此图片
	 */
	shouldCacheImage(url: string, mimeType?: string): boolean {
		// 如果缓存被全局禁用，直接返回false
		if (!this.shouldUseCache()) {
			return false;
		}

		// 如果提供了MIME类型，直接检查
		if (mimeType) {
			return this.isStaticImageMimeType(mimeType);
		}

		// 否则从URL检查文件扩展名
		const fileExtension = this.getFileExtension(url);
		return this.isStaticImageExtension(fileExtension);
	}

	/**
	 * 检查是否应该使用缓存
	 */
	shouldUseCache(): boolean {
		if (this.shouldUseCacheCallback) {
			const enabled = this.shouldUseCacheCallback();
			if (!enabled) {
				log.debug(() => `缓存已禁用（通过回调函数）`);
			}
			return enabled;
		}
		log.debug(() => `缓存已启用（默认值）`);
		return true; // 默认启用缓存
	}

	/**
	 * 设置缓存启用状态检查回调
	 */
	setShouldUseCacheCallback(callback: () => boolean): void {
		this.shouldUseCacheCallback = callback;
	}

	/**
	 * 设置最大缓存时间
	 */
	setMaxCacheAge(maxAge: number): void {
		this.maxCacheAge = maxAge;
		this.cleanCache(); // 立即清理可能的过期缓存
	}

	/**
	 * 设置最大缓存大小
	 */
	setMaxCacheSize(maxSize: number): void {
		this.maxCacheSize = maxSize;
		this.cleanCache(); // 立即清理可能超出大小的缓存
	}

	/**
	 * 获取缓存大小（字节）
	 */
	getCacheSize(): number {
		return this.totalCacheSize;
	}

	/**
	 * 清空所有缓存
	 */
	async clearAllCache() {
		try {
			// 清除所有缓存文件
			for (const url of Object.keys(this.cacheIndex)) {
				await this.removeCacheEntry(url);
			}

			await this.cleanupOrphanedFiles();

			// 重置索引和总大小
			this.cacheIndex = {};
			this.totalCacheSize = 0;

			// 保存空索引
			await this.saveCacheIndex();

			log.debug(() => `所有缓存已清除`);
		} catch (e) {
			log.error(() => `清除所有缓存失败:`, e);
		}
	}

	/**
	 * 清理孤立的缓存文件（目录中存在但索引中没有的文件）
	 */
	async cleanupOrphanedFiles(): Promise<void> {
		try {
			const adapter = this.app.vault.adapter;

			// 获取缓存目录中的所有文件
			const cacheFiles = await this.listCacheDirectoryFiles();

			// 创建一个基于索引的有效文件名集合
			const validFilenames = new Set<string>();
			for (const url in this.cacheIndex) {
				validFilenames.add(this.cacheIndex[url].filename);
			}

			// 查找孤立文件（目录中存在但索引中没有的文件）
			const orphanedFiles: string[] = [];
			for (const filename of cacheFiles) {
				// 跳过 index.json 文件，它是索引文件，不是缓存图片
				if (filename === 'index.json') {
					continue;
				}
				if (!validFilenames.has(filename)) {
					orphanedFiles.push(filename);
				}
			}

			// 删除孤立文件
			for (const filename of orphanedFiles) {
				const filePath = `${this.cacheDir}/${filename}`;
				try {
					await adapter.remove(filePath);
					log.debug(() => `已删除孤立的缓存文件: ${filename}`);
				} catch (e) {
					log.error(() => `删除孤立的缓存文件失败: ${filename}`, e);
				}
			}

			if (orphanedFiles.length > 0) {
				log.debug(() => `共删除了 ${orphanedFiles.length} 个孤立的缓存文件`);
			}
		} catch (e) {
			log.error(() => `清理孤立文件失败:`, e);
		}
	}

	/**
	 * 列出缓存目录中的所有文件
	 * @returns 缓存目录中的文件名数组
	 */
	private async listCacheDirectoryFiles(): Promise<string[]> {
		try {
			// 方法1: 如果适配器有list方法（可能不是所有适配器都有）
			if (typeof this.app.vault.adapter.list === 'function') {
				const {files} = await this.app.vault.adapter.list(this.cacheDir);
				return files.map(filePath => {
					// 从完整路径中提取文件名
					const parts = filePath.split('/');
					return parts[parts.length - 1];
				});
			}

			// 方法2: 替代方法 - 使用TFile对象
			const allFiles = this.app.vault.getFiles();
			const cacheFiles = allFiles.filter(file => {
				return file.path.startsWith(this.cacheDir + '/');
			});

			return cacheFiles.map(file => file.name);
		} catch (e) {
			log.error(() => `列出缓存目录文件失败:`, e);
			return [];
		}
	}
}
