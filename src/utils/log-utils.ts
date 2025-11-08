
export enum LogLevel {
	DEBUG = 0,
	INFO = 1,
	WARN = 2,
	ERROR = 3,
	NONE = 4
}

export enum LogCategory {
	CACHE = 'CACHE',
	LOADING = 'LOADING',
	UI = 'UI',
	NETWORK = 'NETWORK',
	GENERAL = 'GENERAL'
}

/**
 * 日志工具类，支持通过配置控制调试模式
 */
export class Logger {
	private readonly pluginName: string;
	private logLevel: LogLevel;
	private debugMode: boolean;
	private enabledCategories: Set<LogCategory>;

	/**
	 * 创建日志工具实例
	 * @param pluginName 插件名称，将显示在日志前缀中
	 * @param logLevel 初始日志级别，默认为INFO
	 * @param debugMode 是否启用调试模式，默认为false
	 */
	constructor(pluginName: string, logLevel: LogLevel = LogLevel.INFO, debugMode = false) {
		this.pluginName = pluginName;
		this.logLevel = logLevel;
		this.debugMode = debugMode;
		this.enabledCategories = new Set(Object.values(LogCategory));

		// 输出初始化信息
		this.info(`日志系统初始化: 级别=${LogLevel[logLevel]}, 调试模式=${debugMode}`);
	}

	setEnabledCategories(categories: LogCategory[]): void {
		this.enabledCategories = new Set(categories);
	}

	private isCategoryEnabled(category: LogCategory): boolean {
		return this.enabledCategories.has(category);
	}

	/**
	 * 设置调试模式状态
	 * @param enabled 是否启用调试模式
	 */
	public setDebugMode(enabled: boolean): void {
		if (this.debugMode !== enabled) {
			console.log(`[${this.pluginName}] 调试模式${enabled ? '开启' : '关闭'}`);
			this.debugMode = enabled;
		}
	}

	/**
	 * 获取当前调试模式状态
	 * @returns 调试模式是否启用
	 */
	public isDebugMode(): boolean {
		return this.debugMode;
	}

	/**
	 * 输出调试级别日志
	 * @param message 日志消息或返回日志消息的函数
	 */
	public debug(message: string | (() => string), category: LogCategory = LogCategory.GENERAL): void {
		// 当调试模式开启或日志级别设置为DEBUG时显示调试日志
		if ((this.debugMode || this.logLevel <= LogLevel.DEBUG) && this.isCategoryEnabled(category)) {
			const finalMessage = typeof message === 'function' ? message() : message;
			console.log(`[${this.pluginName}] [DEBUG] [${category}] ${finalMessage}`);
		}
	}

	/**
	 * 输出信息级别日志
	 * @param message 日志消息或返回日志消息的函数
	 */
	public info(message: string | (() => string)): void {
		if (this.logLevel <= LogLevel.INFO) {
			const finalMessage = typeof message === 'function' ? message() : message;
			console.log(`[${this.pluginName}] [INFO] ${finalMessage}`);
		}
	}

	/**
	 * 输出警告级别日志
	 * @param message 日志消息或返回日志消息的函数
	 */
	public warn(message: string | (() => string)): void {
		if (this.logLevel <= LogLevel.WARN) {
			const finalMessage = typeof message === 'function' ? message() : message;
			console.warn(`[${this.pluginName}] [WARN] ${finalMessage}`);
		}
	}

	/**
	 * 输出错误级别日志
	 * @param message 日志消息或返回日志消息的函数
	 * @param error 可选的错误对象
	 */
	public error(message: string | (() => string), error?: Error): void {
		if (this.logLevel <= LogLevel.ERROR) {
			const finalMessage = typeof message === 'function' ? message() : message;
			if (error) {
				console.error(`[${this.pluginName}] [ERROR] ${finalMessage}`, error);
			} else {
				console.error(`[${this.pluginName}] [ERROR] ${finalMessage}`);
			}
		}
	}

	/**
	 * 设置日志级别
	 * @param level 新的日志级别
	 */
	public setLogLevel(level: LogLevel): void {
		this.logLevel = level;
		this.info(`日志级别已设置为: ${LogLevel[level]}`);
	}

	/**
	 * 获取当前日志级别
	 * @returns 当前日志级别
	 */
	public getLogLevel(): LogLevel {
		return this.logLevel;
	}
}

export const log = new Logger('Note Image Gallery');

/**
 * 创建可定制的日志记录器
 * @param pluginName 插件名称
 * @param logLevel 日志级别
 * @param debugMode 是否启用调试模式
 * @returns 新的Logger实例
 */
export const createLogger = (
	pluginName: string,
	logLevel: LogLevel = LogLevel.INFO,
	debugMode = false
): Logger => {
	return new Logger(pluginName, logLevel, debugMode);
};

