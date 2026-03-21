/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:test";
import { createPublishedWorkerTools, dispatchPublishedWorker } from "./published-workers.js";

type FileEntry = { content: string; updatedAt: number };
type RouteEntry = { name: string; file: string; updatedAt: number };

function createMemoryStores(initialFiles: Record<string, FileEntry>) {
	const files = new Map(Object.entries(initialFiles));
	const routes = new Map<string, RouteEntry>();

	const fileStore = {
		get: async (path: string) => files.get(path)?.content,
		list: async () => [...files.keys()].sort(),
		getUpdatedAt: async (path: string) => files.get(path)?.updatedAt,
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

		const [publishWorker] = createPublishedWorkerTools({
			loader: env.LOADER as any,
			fileStore,
			routeStore,
			sessionId: "abc123",
		});

		const published = await publishWorker.execute("publish-1", {
			name: "hello",
			file: "workers/hello.js",
		});
		expect(published.content[0]?.text).toContain("/w/abc123/hello");

		const response = await dispatchPublishedWorker(
			{
				loader: env.LOADER as any,
				fileStore,
				routeStore,
				sessionId: "abc123",
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

		const [publishWorker] = createPublishedWorkerTools({
			loader: env.LOADER as any,
			fileStore,
			routeStore,
			sessionId: "imports",
		});
		await publishWorker.execute("publish-2", {
			name: "import-test",
			file: "workers/entry.js",
		});

		const response = await dispatchPublishedWorker(
			{
				loader: env.LOADER as any,
				fileStore,
				routeStore,
				sessionId: "imports",
			},
			"import-test",
			new Request("https://example.com/w/imports/import-test"),
			"/",
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("hello from import");
	});
});
