/**
 * Sandbox cold start benchmark.
 *
 * GET /cold  — force a new container (unique ID) and time it
 * GET /warm  — reuse a known container and time it
 * GET /pool  — hit a random slot from a pool of 3
 */

import { getSandbox, type Sandbox } from "@cloudflare/sandbox";

export { Sandbox } from "@cloudflare/sandbox";

interface Env {
	SANDBOX: DurableObjectNamespace<Sandbox>;
}

async function timeSandbox(sandbox: ReturnType<typeof getSandbox>, label: string) {
	const times: Record<string, number> = {};
	const t0 = Date.now();

	// 1. First exec — triggers container start if cold
	const r1 = await sandbox.exec("echo ready");
	times.firstExec = Date.now() - t0;

	// 2. Second exec — container is warm
	const t2 = Date.now();
	await sandbox.exec("echo warm");
	times.secondExec = Date.now() - t2;

	// 3. Run ffprobe (heavier binary, tests if tools are usable)
	const t3 = Date.now();
	await sandbox.exec("ffmpeg -version 2>/dev/null | head -1 || echo 'no ffmpeg'");
	times.ffmpegVersion = Date.now() - t3;

	// 4. Write + read a file
	const t4 = Date.now();
	await sandbox.writeFile("/tmp/bench.txt", "hello");
	const f = await sandbox.readFile("/tmp/bench.txt");
	times.writeRead = Date.now() - t4;

	times.total = Date.now() - t0;

	return {
		label,
		success: r1.success,
		times,
	};
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/cold") {
			const id = `bench-cold-${Date.now()}`;
			const result = await timeSandbox(getSandbox(env.SANDBOX, id), `cold (${id})`);
			return Response.json(result);
		}

		if (url.pathname === "/warm") {
			const result = await timeSandbox(getSandbox(env.SANDBOX, "bench-warm"), "warm (bench-warm)");
			return Response.json(result);
		}

		if (url.pathname === "/pool") {
			const slot = Math.floor(Math.random() * 3);
			const id = `bench-pool-${slot}`;
			const result = await timeSandbox(getSandbox(env.SANDBOX, id), `pool slot ${slot} (${id})`);
			return Response.json(result);
		}

		return Response.json({
			endpoints: {
				"/cold": "Force new container, measure cold start",
				"/warm": "Reuse fixed container, measure warm latency",
				"/pool": "Random slot from pool of 3",
			},
		});
	},
};
