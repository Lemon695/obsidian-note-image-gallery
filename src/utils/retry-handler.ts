import {log} from "./log-utils";

/**
 * Retry handler
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
					log.debug(() => `${context || 'Operation'} failed, retrying ${attempt + 1}/${this.maxRetries}`);
					this.onRetry?.(attempt + 1);
					// exponential backoff to avoid immediate retry
					await new Promise(resolve => window.setTimeout(resolve, Math.min(1000 * Math.pow(2, attempt), 5000)));
				} else {
					log.error(() => `${context || 'Operation'} reached max retries`, error as Error);
					this.onFinalFailure?.(error as Error);
				}
			}
		}

		throw lastError || new Error('Unknown error occurred during retry');
	}
}
