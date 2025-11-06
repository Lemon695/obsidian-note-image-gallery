import {log} from "./log-utils";

/**
 * 重试处理器
 */
export class RetryHandler {
	constructor(
		private maxRetries: number = 3,
		private onRetry?: (attempt: number) => void,
		private onFinalFailure?: (error: Error) => void
	) {
	}

	async execute<T>(
		operation: () => Promise<T>,
		context?: string
	): Promise<T> {
		let lastError: Error | null = null;

		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			try {
				return await operation();
			} catch (error) {
				lastError = error as Error;

				if (attempt < this.maxRetries) {
					log.debug(() => `${context || '操作'} 失败，重试 ${attempt + 1}/${this.maxRetries}`);
					this.onRetry?.(attempt + 1);
					// 添加指数退避延迟，避免立即重试
					await new Promise(resolve => setTimeout(resolve, Math.min(1000 * Math.pow(2, attempt), 5000)));
				} else {
					log.error(() => `${context || '操作'} 达到最大重试次数`, error as Error);
					this.onFinalFailure?.(error as Error);
				}
			}
		}

		throw lastError;
	}
}
