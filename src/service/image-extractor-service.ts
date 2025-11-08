/**
 * 图片提取器接口
 */
interface ImageExtractor {
	extract(content: string): string[];
}

/**
 * 混合格式图片提取器
 * 处理格式：![[备注名]](实际URL)
 * 这种格式常见于从社交媒体复制的内容
 * 只提取括号中的URL，忽略[[]]中的备注文本
 */
class HybridImageExtractor implements ImageExtractor {
	// 匹配 ![[...]](...) 格式，只捕获括号中的URL
	private readonly regex = /!\[\[.*?]]\((.*?)\)/g;

	extract(content: string): string[] {
		const images: string[] = [];
		let match;

		while ((match = this.regex.exec(content)) !== null) {
			if (match[1]) {
				const imagePath = this.processImagePath(match[1]);
				if (imagePath) {
					images.push(imagePath);
				}
			}
		}

		return images;
	}

	private processImagePath(path: string): string {
		// 移除引号和空格，只保留URL
		return path.trim().replace(/['"]/g, '');
	}
}

/**
 * Wiki 风格图片提取器
 * 处理格式：![[图片文件名]]
 */
class WikiImageExtractor implements ImageExtractor {
	// 修改正则：不匹配后面紧跟 ](  的情况（混合格式）
	private readonly regex = /!\[\[(.*?)]](?!\()/g;

	extract(content: string): string[] {
		const images: string[] = [];
		let match;

		while ((match = this.regex.exec(content)) !== null) {
			if (match[1]) {
				const imagePath = this.cleanImagePath(match[1]);
				if (imagePath) {
					images.push(imagePath);
				}
			}
		}

		return images;
	}

	private cleanImagePath(path: string): string {
		// 移除路径中的管道符号后的内容（如果存在）
		const cleanPath = path.split('|')[0].trim();

		// 过滤掉 markdown 文件
		if (cleanPath.toLowerCase().endsWith('.md')) {
			return '';
		}

		return cleanPath;
	}
}

/**
 * Markdown 标准图片提取器
 * 处理格式：![alt](image.jpg)
 */
class MarkdownImageExtractor implements ImageExtractor {
	// 修改正则：不匹配前面是 ]] 的情况（混合格式）
	private readonly regex = /(?<!]])![.*?]\((.*?)\)/g;

	extract(content: string): string[] {
		const images: string[] = [];
		let match;

		while ((match = this.regex.exec(content)) !== null) {
			if (match[1]) {
				const imagePath = this.processImagePath(match[1]);
				if (imagePath) {
					images.push(imagePath);
				}
			}
		}

		return images;
	}

	private processImagePath(path: string): string {
		// 处理图片路径，移除可能的引号和空格
		const cleanPath = path.trim().replace(/['"]/g, '');

		// 过滤掉 markdown 文件
		if (cleanPath.toLowerCase().endsWith('.md')) {
			return '';
		}

		return cleanPath;
	}
}

/**
 * 简单图片链接提取器
 * 处理格式：![](image.jpg)
 */
class SimpleImageExtractor implements ImageExtractor {
	private readonly regex = /!\[]\((.*?)\)/g;

	extract(content: string): string[] {
		const images: string[] = [];
		let match;

		while ((match = this.regex.exec(content)) !== null) {
			if (match[1]) {
				const imagePath = this.processImagePath(match[1]);
				if (imagePath) {
					images.push(imagePath);
				}
			}
		}

		return images;
	}

	private processImagePath(path: string): string {
		const trimmedPath = path.trim();
		// 移除路径中的引号（如果存在）
		const cleanPath = trimmedPath.replace(/['"]/g, '');

		// 过滤掉 markdown 文件
		if (cleanPath.toLowerCase().endsWith('.md')) {
			return '';
		}

		return cleanPath;
	}
}

export class ImageExtractorService {
	private readonly extractors: ImageExtractor[];

	constructor() {
		// 重要：HybridImageExtractor 必须放在最前面
		// 这样可以优先处理混合格式，避免被其他提取器误匹配
		this.extractors = [
			new HybridImageExtractor(),
			new WikiImageExtractor(),
			new MarkdownImageExtractor(),
			new SimpleImageExtractor()
		];
	}

	/**
	 * 从内容中提取所有图片路径
	 * @param content 要解析的文档内容
	 * @returns 去重后的图片路径数组
	 */
	extractImages(content: string): string[] {
		// 使用所有提取器提取图片
		const allImages = this.extractors
			.flatMap(extractor => extractor.extract(content))
			.filter(Boolean) // 移除空值
			.filter(path => this.isValidImagePath(path)); // 过滤掉明显不是图片的路径

		// 去重并返回结果
		return [...new Set(allImages)];
	}

	/**
	 * 检查路径是否是有效的图片路径
	 * @param path 图片路径或URL
	 * @returns 是否是有效的图片路径
	 */
	private isValidImagePath(path: string): boolean {
		// 排除空路径
		if (!path || path.trim().length === 0) {
			return false;
		}

		// 排除 markdown 文件
		if (path.toLowerCase().endsWith('.md')) {
			return false;
		}

		// 本地路径：检查是否有图片扩展名或让 Obsidian 处理
		if (!path.startsWith('http://') && !path.startsWith('https://')) {
			// 如果有扩展名，检查是否是图片扩展名
			if (path.includes('.')) {
				const imageExtensions = /\.(jpg|jpeg|png|gif|webp|bmp|svg|tiff?|ico|avif)$/i;
				return imageExtensions.test(path);
			}
			// 没有扩展名的本地路径，让 Obsidian 自己处理（可能是无扩展名的文件）
			return true;
		}

		// 网络URL：检查是否以常见图片扩展名结尾（忽略查询参数）
		return this.isLikelyImageUrl(path);
	}

	/**
	 * 检查URL是否可能是图片
	 * @param path 图片URL
	 * @returns 是否可能是图片
	 */
	private isLikelyImageUrl(path: string): boolean {
		const urlWithoutParams = path.split('?')[0].split('#')[0];
		const imageExtensions = /\.(jpg|jpeg|png|gif|webp|bmp|svg|tiff?|ico|avif)$/i;

		// 如果URL路径包含明显的图片扩展名，认为是图片
		if (imageExtensions.test(urlWithoutParams)) {
			return true;
		}

		// 检查URL路径的最后一部分
		const pathParts = urlWithoutParams.split('/');
		const lastPart = pathParts[pathParts.length - 1];

		// 如果最后一部分看起来像文件名（包含.），检查扩展名
		if (lastPart.includes('.')) {
			return imageExtensions.test(lastPart);
		}

		// Twitter/X 特殊处理：pbs.twimg.com 的图片URL可能没有扩展名
		// 但通常包含 /media/ 路径且有 format 参数
		if (path.includes('pbs.twimg.com/media/') && path.includes('format=')) {
			return true;
		}

		// 微博图床特殊处理：sinaimg.cn 和 sinajs.cn
		if (path.includes('sinaimg.cn') || path.includes('sinajs.cn')) {
			return true;
		}

		// 其他情况：如果没有明确的图片扩展名，且不是特殊图床，则不认为是图片
		// 这会过滤掉如 x.com/status/... 这样的链接
		return false;
	}
}
