import {App, TFile, requestUrl, RequestUrlParam, RequestUrlResponse} from 'obsidian';
import {log} from '../utils/log-utils';
import NoteImageGalleryPlugin from '../main';

/**
 * Obsidian 图片加载器服务
 */
export class ObsidianImageLoader {
	private app: App;
	private plugin: NoteImageGalleryPlugin;

	constructor(app: App, plugin: NoteImageGalleryPlugin) {
		this.app = app;
		this.plugin = plugin;
	}

	/**
	 * 使用 Obsidian API 加载本地图片
	 * @param imagePath 图片路径
	 * @param img 目标图片元素
	 * @returns 是否成功加载图片的Promise
	 */
	async loadLocalImage(imagePath: string, img: HTMLImageElement): Promise<boolean> {
		try {
			let tfile: TFile | null = null;

			const abstractFile = this.app.vault.getAbstractFileByPath(imagePath);
			if (abstractFile instanceof TFile) {
				tfile = abstractFile;
			} else {
				const linkedFile = this.app.metadataCache.getFirstLinkpathDest(imagePath, '');
				if (linkedFile instanceof TFile) {
					tfile = linkedFile;
				}
			}

			if (tfile) {
				const arrayBuffer = await this.app.vault.readBinary(tfile);

				const blob = new Blob([arrayBuffer]);
				const objectUrl = URL.createObjectURL(blob);

				const oldObjectUrl = img.getAttribute('data-object-url');
				if (oldObjectUrl) {
					URL.revokeObjectURL(oldObjectUrl);
				}

				img.setAttribute('data-object-url', objectUrl);

				img.src = objectUrl;
				return true;
			}

			return false;
		} catch (error) {
			log.error(() => `通过Obsidian API加载本地图片失败: ${imagePath}`, error);
			return false;
		}
	}

	/**
	 * 尝试获取文件的替代路径
	 * @param originalPath 原始路径
	 * @returns 可能的替代路径数组
	 */
	getAlternativeLocalPaths(originalPath: string): string[] {
		const result: string[] = [];

		try {
			result.push(originalPath);

			if (originalPath.includes('_resources/')) {
				const withoutResources = originalPath.replace('_resources/', '');
				result.push(withoutResources);
			} else {
				result.push(`_resources/${originalPath}`);
			}

			const filename = originalPath.split('/').pop();
			if (filename) {
				const activeFile = this.app.workspace.getActiveFile();

				if (activeFile && activeFile.parent) {
					const relativePath = `${activeFile.parent.path}/${filename}`;
					result.push(relativePath);

					result.push(`${activeFile.parent.path}/_resources/${filename}`);
					result.push(`${activeFile.parent.path}/_attachments/${filename}`);
					result.push(`${activeFile.parent.path}/attachments/${filename}`);
				}

				const matchingFiles = this.app.vault.getFiles().filter(f => f.name === filename);
				for (const file of matchingFiles) {
					result.push(file.path);
				}
			}

			const allFiles = this.app.vault.getFiles();
			const matchingPathFiles = allFiles.filter(f => f.path.includes(originalPath));
			for (const file of matchingPathFiles) {
				result.push(file.path);
			}

			return [...new Set(result)];
		} catch (error) {
			log.error(() => `生成替代路径时出错:`, error);
			return [originalPath]; // 出错时返回原始路径
		}
	}

	/**
	 * 获取资源路径
	 * @param path 文件路径
	 * @returns Obsidian资源URL
	 */
	getResourcePath(path: string): string {
		return this.app.vault.adapter.getResourcePath(path);
	}

	/**
	 * 使用 Obsidian requestUrl API 加载网络图片
	 * @param imageUrl 图片URL
	 * @param img 目标图片元素
	 * @returns 是否成功加载图片的Promise
	 */
	async loadNetworkImage(imageUrl: string, img: HTMLImageElement): Promise<boolean> {
		try {
			const requestOptions: RequestUrlParam = {
				url: imageUrl,
				method: 'GET',
				headers: {
					'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
					'Cache-Control': 'no-cache'
				},
				contentType: 'arraybuffer'
			};

			const response: RequestUrlResponse = await requestUrl(requestOptions);
			if (response.status < 200 || response.status >= 300) {
				throw new Error(`HTTP error: ${response.status}`);
			}

			const arrayBuffer = response.arrayBuffer;
			if (!arrayBuffer) {
				throw new Error('No data received');
			}

			const contentType = response.headers?.['content-type'] || 'image/jpeg';
			const blob = new Blob([arrayBuffer], {type: contentType});
			const objectUrl = URL.createObjectURL(blob);

			const oldObjectUrl = img.getAttribute('data-object-url');
			if (oldObjectUrl) {
				URL.revokeObjectURL(oldObjectUrl);
			}

			img.setAttribute('data-object-url', objectUrl);
			img.src = objectUrl;

			try {
				log.debug(() => `尝试缓存网络图片: ${imageUrl}, 内容类型: ${contentType}`);

				await this.plugin.imageCacheService.cacheImage(
					imageUrl,
					arrayBuffer,
					response.headers?.['etag'],
					contentType
				);
			} catch (error) {
				log.error(() => `缓存图片失败: ${imageUrl}`, error);
			}

			return true;
		} catch (error) {
			log.error(() => `通过Obsidian API加载网络图片失败: ${imageUrl}`, error);
			return false;
		}
	}

	/**
	 * 判断是否是网络图片URL
	 * @param url 图片URL
	 * @returns 是否是网络图片
	 */
	isNetworkImage(url: string): boolean {
		return url.startsWith('http://') || url.startsWith('https://');
	}

	/**
	 * 释放加载器创建的资源
	 * @param img 图片元素
	 */
	revokeImageResources(img: HTMLImageElement): void {
		const objectUrl = img.getAttribute('data-object-url');
		if (objectUrl) {
			URL.revokeObjectURL(objectUrl);
			img.removeAttribute('data-object-url');
		}
	}
}
