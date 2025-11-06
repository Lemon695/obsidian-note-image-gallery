declare module 'electron' {
	export interface NetRequest {
		on(event: 'response', listener: (response: IncomingMessage) => void): this;

		on(event: 'error', listener: (error: Error) => void): this;

		abort(): void;

		end(): void;
	}

	export interface IncomingMessage {
		statusCode: number;
		headers: Record<string, string | string[]>;

		on(event: 'data', listener: (chunk: Buffer) => void): this;

		on(event: 'end', listener: () => void): this;
	}

	export interface Net {
		request(options: { url: string; headers?: Record<string, string> }): NetRequest;
	}

	export interface Remote {
		net: Net;
	}
}
