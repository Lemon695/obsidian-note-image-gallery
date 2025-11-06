/**
 * 图片提取器接口
 */
interface ImageExtractor {
	extract(content: string): string[];
}

/**
 * Wiki 风格图片提取器
 */
class WikiImageExtractor implements ImageExtractor {
	private readonly regex = /!\[\[(.*?)]]/g;

	extract(content: string): string[] {
		const images: string[] = [];
		let match;

		while ((match = this.regex.exec(content)) !== null) {
			if (match[1]) {
				const imagePath = this.cleanImagePath(match[1]);
				images.push(imagePath);
			}
		}

		return images;
	}

	private cleanImagePath(path: string): string {
		// 移除路径中的管道符号后的内容（如果存在）
		return path.split('|')[0].trim();
	}
}

/**
 * Markdown 标准图片提取器
 * 处理格式：![alt](image.jpg)
 */
class MarkdownImageExtractor implements ImageExtractor {
	private readonly regex = /!\[.*?]\((.*?)\)/g;

	extract(content: string): string[] {
		const images: string[] = [];
		let match;

		while ((match = this.regex.exec(content)) !== null) {
			if (match[1]) {
				const imagePath = this.processImagePath(match[1]);
				images.push(imagePath);
			}
		}

		return images;
	}

	private processImagePath(path: string): string {
		// 处理图片路径，移除可能的引号和空格
		return path.trim().replace(/['"]/g, '');
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
		return trimmedPath.replace(/['"]/g, '');
	}
}

export class ImageExtractorService {
	private readonly extractors: ImageExtractor[];

	constructor() {
		this.extractors = [
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
			.filter(path => this.isLikelyImageUrl(path)); // 过滤掉明显不是图片的URL

		// 去重并返回结果
		return [...new Set(allImages)];
	}

	/**
	 * 检查URL是否可能是图片
	 * @param path 图片路径或URL
	 * @returns 是否可能是图片
	 */
	private isLikelyImageUrl(path: string): boolean {
		// 本地路径直接返回true（由Obsidian处理验证）
		if (!path.startsWith('http://') && !path.startsWith('https://')) {
			return true;
		}

		// 网络URL：检查是否以常见图片扩展名结尾（忽略查询参数）
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

		// 其他情况：如果没有明确的图片扩展名，且不是特殊图床，则不认为是图片
		// 这会过滤掉如 x.com/status/... 这样的链接
		return false;
	}
}
