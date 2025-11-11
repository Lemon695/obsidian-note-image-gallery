export const translations = {
	'en-GB': {
		// Command names
		currentFile: 'Current file',
		clearImageCache: 'Clear image cache',

		// Main plugin
		loadingPlugin: 'Loading plugin v',
		openGallery: 'Open gallery',
		imageCacheCleared: 'Image cache cleared',
		noImagesFound: 'No images found in current note',
		errorOpeningGallery: 'Error opening image gallery',
		cacheIndexSaved: 'Cache index saved',
		saveCacheIndexFailed: 'Failed to save cache index:',

		// Settings
		imageGallerySettings: 'Image Gallery Settings',
		enableCache: 'Enable image cache',
		enableCacheDesc: 'Cache remote images to speed up loading',
		cacheValidPeriod: 'Cache valid period',
		cacheValidPeriodDesc: 'Maximum valid period for image cache: {days} days',
		cacheValidPeriodError: 'Cache valid period must be between 1-60 days',
		cacheValidPeriodValue: 'Maximum valid period for image cache: {value} days',
		cacheSizeZeroOrInvalid: 'Cache size is 0 or invalid',
		getCacheSizeFailed: 'Failed to get cache size:',
		unableToGetCacheSize: 'Unable to get cache size, please try to reinitialize cache',
		cacheStatus: 'Cache Status',
		currentCacheSize: 'Current cache size: {size} MB / {maxSize} MB',
		maxCacheSize: 'Maximum cache size',
		maxCacheSizeDesc: 'Maximum size for image cache: {size} MB',
		refreshCacheStatus: 'Refresh cache status',
		recalculateCacheSize: 'Recalculate cache size',
		refresh: 'Refresh',
		clearCache: 'Clear cache',
		clearCacheDesc: 'Delete all cached images',
		clearAllCache: 'Clear all cache',
		developer: 'Developer',
		debugMode: 'Debug mode',
		debugModeDesc: 'Enable debug mode to log detailed information to the console.',
		debugModeStatus: 'Debug mode {status}',
		enabled: 'enabled',
		disabled: 'disabled',

		// Image gallery
		imageGalleryTitle: 'Image Gallery ({count} images)',
		sort: 'Sort: ',
		defaultSort: 'Default sort',
		sortBySizeDesc: 'By size (large to small)',
		sortBySizeAsc: 'By size (small to large)',
		filter: 'Filter: ',
		all: 'All',
		localImages: 'Local images',
		networkImages: 'Network images',
		loading: 'Loading...',
		loadingFromCache: 'Loading from cache...',
		loadingFailed: 'Loading failed',
		imageNotFound: 'Image not found',
		processingFailed: 'Processing failed',
		imageCopied: 'Image copied to clipboard',
		copyFailed: 'Copy failed, please try again',
		downloadingImage: 'Downloading image',
		downloadFailed: 'Image download failed',
		copyImage: 'Copy image',
		downloadImage: 'Download image',

		// Log messages
		logSystemInit: 'Log system initialized: level={level}, debug mode={debugMode}',
		debugModeToggle: 'Debug mode {status}',
		on: 'on',
		off: 'off',
		logLevelSet: 'Log level set to: {level}',
	},
	'zh': {
		// Command names
		currentFile: '当前文件',
		clearImageCache: '清除图片缓存',

		// Main plugin
		loadingPlugin: '加载插件 v',
		openGallery: '打开图片墙',
		imageCacheCleared: '图片缓存已清除',
		noImagesFound: '当前笔记中未找到图片',
		errorOpeningGallery: '打开图片墙时出错',
		cacheIndexSaved: '缓存索引已保存',
		saveCacheIndexFailed: '保存缓存索引失败:',

		// Settings
		imageGallerySettings: '图片墙设置',
		enableCache: '启用图片缓存',
		enableCacheDesc: '启用后，将缓存远程图片以加快加载速度',
		cacheValidPeriod: '缓存有效期',
		cacheValidPeriodDesc: '图片缓存的最大有效期: {days} 天',
		cacheValidPeriodError: '缓存有效期必须在1-60天之间',
		cacheValidPeriodValue: '图片缓存的最大有效期: {value} 天',
		cacheSizeZeroOrInvalid: '缓存大小为0或无效',
		getCacheSizeFailed: '获取缓存大小失败:',
		unableToGetCacheSize: '无法获取缓存大小，请尝试重新初始化缓存',
		cacheStatus: '缓存状态',
		currentCacheSize: '当前缓存大小: {size} MB / {maxSize} MB',
		maxCacheSize: '最大缓存大小',
		maxCacheSizeDesc: '图片缓存的最大大小: {size} MB',
		refreshCacheStatus: '刷新缓存状态',
		recalculateCacheSize: '重新计算缓存大小',
		refresh: '刷新',
		clearCache: '清除缓存',
		clearCacheDesc: '删除所有缓存的图片',
		clearAllCache: '清除全部缓存',
		developer: '开发者',
		debugMode: '调试模式',
		debugModeDesc: '启用调试模式以在控制台中记录详细信息。',
		debugModeStatus: '调试模式已{status}',
		enabled: '启用',
		disabled: '禁用',

		// Image gallery
		imageGalleryTitle: '图片墙 ({count} 张图片)',
		sort: '排序: ',
		defaultSort: '默认排序',
		sortBySizeDesc: '按尺寸（大到小）',
		sortBySizeAsc: '按尺寸（小到大）',
		filter: '筛选: ',
		all: '全部',
		localImages: '本地图片',
		networkImages: '网络图片',
		loading: '加载中...',
		loadingFromCache: '从缓存加载...',
		loadingFailed: '加载失败',
		imageNotFound: '找不到图片',
		processingFailed: '处理失败',
		imageCopied: '图片已复制到剪贴板',
		copyFailed: '复制失败，请重试',
		downloadingImage: '正在下载图片',
		downloadFailed: '图片下载失败',
		copyImage: '复制图片',
		downloadImage: '下载图片',

		// Log messages
		logSystemInit: '日志系统初始化: 级别={level}, 调试模式={debugMode}',
		debugModeToggle: '调试模式{status}',
		on: '开启',
		off: '关闭',
		logLevelSet: '日志级别已设置为: {level}',
	}
};

type Locale = keyof typeof translations;

export function getLocale(): Locale {
	const lang = window.localStorage.getItem('language') || 'en-GB';
	return (lang in translations ? lang : 'en-GB') as Locale;
}

export function t(key: keyof typeof translations["en-GB"], params?: Record<string, string>): string {
	const locale = getLocale();
	let text = translations[locale][key] || translations["en-GB"][key];
	// 替换占位符
	if (params) {
		Object.keys(params).forEach(paramKey => {
			text = text.replace(new RegExp(`\\{${paramKey}\\}`, 'g'), params[paramKey]);
		});
	}
	return text;
}

/**
 * 调试函数：打印当前语言设置
 */
export function debugLocale(): void {
	console.log('=== Locale Debug Info ===');
	console.log('Current locale:', getLocale());
	console.log('localStorage language:', window.localStorage.getItem('language'));
	console.log('navigator.language:', navigator.language);
	console.log('moment locale:', (window as any).moment?.locale());
	console.log('========================');
}
