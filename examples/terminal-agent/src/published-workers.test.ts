/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:test";
import { createPublishedWorkerTools, dispatchPublishedWorker } from "./published-workers.js";

type FileEntry = { content: string; updatedAt: number };
type RouteEntry = { name: string; file: string; updatedAt: number };

function createCountingLoader(loader: any) {
	let buildCount = 0;
	return {
		loader: {
			get(id: string, cb: () => any) {
				return loader.get(id, () => {
					buildCount++;
					return cb();
				});
			},
		},
		getBuildCount: () => buildCount,
	};
}

function createMemoryStores(initialFiles: Record<string, FileEntry>) {
	const files = new Map(Object.entries(initialFiles));
	const routes = new Map<string, RouteEntry>();

	const fileStore = {
		get: async (path: string) => files.get(path)?.content,
		list: async () => [...files.keys()].sort(),
		getUpdatedAt: async (path: string) => files.get(path)?.updatedAt,
		set: (path: string, content: string, updatedAt: number) => {
			files.set(path, { content, updatedAt });
		},
	};

	const routeStore = {
		put: async (name: string, file: string) => {
			routes.set(name, { name, file, updatedAt: Date.now() });
		},
		get: async (name: string) => routes.get(name),
		delete: async (name: string) => routes.delete(name),
		list: async () => [...routes.values()].sort((a, b) => a.name.localeCompare(b.name)),
	};

	return { fileStore, routeStore };
}

describe("published workers", () => {
	it("publishes and serves a filesystem-backed worker through the loader", async () => {
		const { fileStore, routeStore } = createMemoryStores({
			"workers/hello.js": {
				content: [
					"export default {",
					"  async fetch(request) {",
					"    const url = new URL(request.url);",
					"    return Response.json({ ok: true, pathname: url.pathname, search: url.search });",
					"  },",
					"};",
				].join("\n"),
				updatedAt: 1,
			},
		});

		const countingLoader = createCountingLoader(env.LOADER as any);
		const cache = new Map();
		const [publishWorker] = createPublishedWorkerTools({
			loader: countingLoader.loader as any,
			fileStore,
			routeStore,
			sessionId: "abc123",
			cache: {
				get: (key) => cache.get(key),
				put: (key, value) => cache.set(key, value),
				delete: (key) => cache.delete(key),
			},
		});

		const published = await publishWorker.execute("publish-1", {
			name: "hello",
			file: "workers/hello.js",
		});
		expect(published.content[0]?.text).toContain("/w/abc123/hello");

		const response = await dispatchPublishedWorker(
			{
				loader: countingLoader.loader as any,
				fileStore,
				routeStore,
				sessionId: "abc123",
				cache: {
					get: (key) => cache.get(key),
					put: (key, value) => cache.set(key, value),
					delete: (key) => cache.delete(key),
				},
			},
			"hello",
			new Request("https://example.com/w/abc123/hello/nested/path?x=1"),
			"/nested/path",
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			pathname: "/nested/path",
			search: "?x=1",
		});
		expect(countingLoader.getBuildCount()).toBe(1);
	});

	it("supports relative imports inside published workers", async () => {
		const { fileStore, routeStore } = createMemoryStores({
			"workers/message.js": {
				content: 'export const message = "hello from import";\n',
				updatedAt: 1,
			},
			"workers/entry.js": {
				content: [
					'import { message } from "./message.js";',
					"",
					"export default {",
					"  async fetch() {",
					"    return new Response(message);",
					"  },",
					"};",
				].join("\n"),
				updatedAt: 1,
			},
		});

		const countingLoader = createCountingLoader(env.LOADER as any);
		const cache = new Map();
		const [publishWorker] = createPublishedWorkerTools({
			loader: countingLoader.loader as any,
			fileStore,
			routeStore,
			sessionId: "imports",
			cache: {
				get: (key) => cache.get(key),
				put: (key, value) => cache.set(key, value),
				delete: (key) => cache.delete(key),
			},
		});
		await publishWorker.execute("publish-2", {
			name: "import-test",
			file: "workers/entry.js",
		});

		const firstResponse = await dispatchPublishedWorker(
			{
				loader: countingLoader.loader as any,
				fileStore,
				routeStore,
				sessionId: "imports",
				cache: {
					get: (key) => cache.get(key),
					put: (key, value) => cache.set(key, value),
					delete: (key) => cache.delete(key),
				},
			},
			"import-test",
			new Request("https://example.com/w/imports/import-test"),
			"/",
		);

		expect(firstResponse.status).toBe(200);
		expect(await firstResponse.text()).toBe("hello from import");
		expect(countingLoader.getBuildCount()).toBe(1);

		const secondResponse = await dispatchPublishedWorker(
			{
				loader: countingLoader.loader as any,
				fileStore,
				routeStore,
				sessionId: "imports",
				cache: {
					get: (key) => cache.get(key),
					put: (key, value) => cache.set(key, value),
					delete: (key) => cache.delete(key),
				},
			},
			"import-test",
			new Request("https://example.com/w/imports/import-test"),
			"/",
		);
		expect(await secondResponse.text()).toBe("hello from import");
		expect(countingLoader.getBuildCount()).toBe(1);

		fileStore.set("workers/message.js", 'export const message = "updated import";\n', 2);
		const thirdResponse = await dispatchPublishedWorker(
			{
				loader: countingLoader.loader as any,
				fileStore,
				routeStore,
				sessionId: "imports",
				cache: {
					get: (key) => cache.get(key),
					put: (key, value) => cache.set(key, value),
					delete: (key) => cache.delete(key),
				},
			},
			"import-test",
			new Request("https://example.com/w/imports/import-test"),
			"/",
		);
		expect(await thirdResponse.text()).toBe("updated import");
		expect(countingLoader.getBuildCount()).toBe(2);
	});
});
