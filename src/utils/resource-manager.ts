/**
 * 资源管理器 - 统一管理 ObjectURL 的创建和释放
 */
export class ResourceManager {
	private resources = new Map<string, string>();

	createObjectURL(key: string, blob: Blob): string {
		// 先清理旧的
		this.revokeObjectURL(key);

		const url = URL.createObjectURL(blob);
		this.resources.set(key, url);
		return url;
	}

	revokeObjectURL(key: string): void {
		const url = this.resources.get(key);
		if (url) {
			URL.revokeObjectURL(url);
			this.resources.delete(key);
		}
	}

	revokeAll(): void {
		this.resources.forEach(url => URL.revokeObjectURL(url));
		this.resources.clear();
	}

	getObjectURL(key: string): string | undefined {
		return this.resources.get(key);
	}
}
