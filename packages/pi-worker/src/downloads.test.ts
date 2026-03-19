import { describe, it, expect, vi } from "vitest";
import { createDownloadHandler } from "./downloads.js";

function mockBucket(files: Record<string, string> = {}) {
	return {
		put: vi.fn(),
		get: vi.fn(async (key: string) => {
			if (!(key in files)) return null;
			return {
				body: new ReadableStream(),
				httpMetadata: { contentType: "application/octet-stream", contentDisposition: "attachment" },
			};
		}),
	} as any;
}

describe("createDownloadHandler", () => {
	const secret = "test-secret-key";

	it("store() writes to bucket and returns signed path", async () => {
		const bucket = mockBucket();
		const handler = createDownloadHandler(bucket, secret);

		const path = await handler.store("test/file.txt", "hello", { contentType: "text/plain" });

		expect(bucket.put).toHaveBeenCalledOnce();
		expect(path).toContain("/download/");
		expect(path).toContain("expires=");
		expect(path).toContain("sig=");
	});

	it("sign() returns signed path without writing", async () => {
		const bucket = mockBucket();
		const handler = createDownloadHandler(bucket, secret);

		const path = await handler.sign("existing/file.txt");

		expect(bucket.put).not.toHaveBeenCalled();
		expect(path).toContain("/download/");
		expect(path).toContain("sig=");
	});

	it("serve() returns null for non-download requests", async () => {
		const handler = createDownloadHandler(mockBucket(), secret);

		const req = new Request("https://example.com/api/something");
		const result = await handler.serve(req);
		expect(result).toBeNull();
	});

	it("serve() returns null for POST requests", async () => {
		const handler = createDownloadHandler(mockBucket(), secret);

		const req = new Request("https://example.com/download/test", { method: "POST" });
		const result = await handler.serve(req);
		expect(result).toBeNull();
	});

	it("serve() rejects missing signature", async () => {
		const handler = createDownloadHandler(mockBucket(), secret);

		const req = new Request("https://example.com/download/test");
		const result = await handler.serve(req);
		expect(result).not.toBeNull();
		expect(result!.status).toBe(403);
	});

	it("serve() rejects expired links", async () => {
		const handler = createDownloadHandler(mockBucket(), secret);

		const req = new Request("https://example.com/download/test?expires=1000&sig=fake");
		const result = await handler.serve(req);
		expect(result).not.toBeNull();
		expect(result!.status).toBe(403);
	});

	it("store() then serve() round-trips", async () => {
		const bucket = mockBucket({ "test.txt": "hello" });
		const handler = createDownloadHandler(bucket, secret);

		const path = await handler.store("test.txt", "hello");
		const url = new URL(path, "https://example.com");
		const req = new Request(url.href);
		const result = await handler.serve(req);

		expect(result).not.toBeNull();
		expect(result!.status).toBe(200);
	});
});
