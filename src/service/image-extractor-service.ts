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
			.filter(Boolean); // 移除空值

		// 去重并返回结果
		return [...new Set(allImages)];
	}
}
