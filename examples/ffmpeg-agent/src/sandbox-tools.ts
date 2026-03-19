/**
 * Agent tools backed by a Cloudflare Sandbox container with ffmpeg installed.
 *
 * Tools:
 * - ffmpeg: Run ffmpeg commands in the sandbox
 * - exec: Run arbitrary shell commands in the sandbox
 * - upload: Upload a file from R2 into the sandbox
 * - download: Download a file from the sandbox to R2
 * - sandbox_ls: List files in the sandbox
 * - sandbox_read: Read a text file from the sandbox
 * - sandbox_write: Write a text file to the sandbox
 */

import { Type, type Static } from "@sinclair/typebox";

type SandboxInstance = {
	exec: (cmd: string, opts?: any) => Promise<{ success: boolean; stdout: string; stderr: string; exitCode: number }>;
	writeFile: (path: string, content: string, opts?: any) => Promise<void>;
	readFile: (path: string, opts?: any) => Promise<{ content: string; encoding: string }>;
	exists: (path: string) => Promise<{ exists: boolean }>;
	mkdir: (path: string, opts?: any) => Promise<void>;
};

// ---------------------------------------------------------------------------
// ffmpeg
// ---------------------------------------------------------------------------

const ffmpegSchema = Type.Object({
	args: Type.String({
		description:
			"ffmpeg arguments (without the 'ffmpeg' prefix). Example: '-i input.mp4 -vf scale=640:480 output.mp4'",
	}),
});

export function createFfmpegTool(sandbox: SandboxInstance) {
	return {
		name: "ffmpeg" as const,
		label: "ffmpeg",
		description:
			"Run an ffmpeg command in the sandbox. Provide arguments without the 'ffmpeg' prefix. Files in /workspace are persistent. Always use -y to overwrite outputs.",
		parameters: ffmpegSchema,
		execute: async (_id: string, { args }: Static<typeof ffmpegSchema>) => {
			const result = await sandbox.exec(`ffmpeg -y ${args}`, { timeout: 120_000 });
			const output = result.success
				? `ffmpeg completed successfully.\nstdout: ${result.stdout.slice(-2000)}\nstderr: ${result.stderr.slice(-2000)}`
				: `ffmpeg failed (exit ${result.exitCode}).\nstderr: ${result.stderr.slice(-3000)}`;
			return { content: [{ type: "text" as const, text: output }], details: {} };
		},
	};
}

// ---------------------------------------------------------------------------
// exec (general shell)
// ---------------------------------------------------------------------------

const execSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute in the sandbox" }),
});

export function createExecTool(sandbox: SandboxInstance) {
	return {
		name: "exec" as const,
		label: "exec",
		description:
			"Execute a shell command in the sandbox container. The sandbox has a full Linux environment with ffmpeg, imagemagick, python3, node, and common tools.",
		parameters: execSchema,
		execute: async (_id: string, { command }: Static<typeof execSchema>) => {
			const result = await sandbox.exec(command, { timeout: 60_000 });
			const output = result.success
				? result.stdout.slice(-4000) || "(no output)"
				: `Command failed (exit ${result.exitCode}).\nstdout: ${result.stdout.slice(-2000)}\nstderr: ${result.stderr.slice(-2000)}`;
			return { content: [{ type: "text" as const, text: output }], details: {} };
		},
	};
}

// ---------------------------------------------------------------------------
// upload: R2 → sandbox
// ---------------------------------------------------------------------------

const uploadSchema = Type.Object({
	r2Key: Type.String({ description: "R2 key of the file to upload to the sandbox" }),
	sandboxPath: Type.String({ description: "Destination path in the sandbox (e.g. /workspace/input.mp4)" }),
});

export function createUploadTool(sandbox: SandboxInstance, bucket: R2Bucket) {
	return {
		name: "upload" as const,
		label: "upload",
		description: "Upload a file from R2 storage into the sandbox container.",
		parameters: uploadSchema,
		execute: async (_id: string, { r2Key, sandboxPath }: Static<typeof uploadSchema>) => {
			const obj = await bucket.get(r2Key);
			if (!obj) throw new Error(`R2 key not found: ${r2Key}`);

			// Read as base64 for binary files
			const arrayBuffer = await obj.arrayBuffer();
			const bytes = new Uint8Array(arrayBuffer);
			const base64 = btoa(String.fromCharCode(...bytes));

			// Ensure directory exists
			const dir = sandboxPath.substring(0, sandboxPath.lastIndexOf("/"));
			if (dir) await sandbox.mkdir(dir, { recursive: true });

			await sandbox.writeFile(sandboxPath, base64, { encoding: "base64" });

			return {
				content: [{ type: "text" as const, text: `Uploaded ${r2Key} → ${sandboxPath} (${bytes.length} bytes)` }],
				details: {},
			};
		},
	};
}

// ---------------------------------------------------------------------------
// download: sandbox → R2
// ---------------------------------------------------------------------------

const downloadSchema = Type.Object({
	sandboxPath: Type.String({ description: "Path to the file in the sandbox" }),
	r2Key: Type.String({ description: "R2 key to save the file to" }),
});

export function createDownloadTool(sandbox: SandboxInstance, bucket: R2Bucket) {
	return {
		name: "download" as const,
		label: "download",
		description: "Download a file from the sandbox container to R2 storage.",
		parameters: downloadSchema,
		execute: async (_id: string, { sandboxPath, r2Key }: Static<typeof downloadSchema>) => {
			const file = await sandbox.readFile(sandboxPath, { encoding: "base64" });
			const binary = Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0));
			await bucket.put(r2Key, binary);

			return {
				content: [{ type: "text" as const, text: `Downloaded ${sandboxPath} → ${r2Key} (${binary.length} bytes)` }],
				details: {},
			};
		},
	};
}

// ---------------------------------------------------------------------------
// sandbox_ls
// ---------------------------------------------------------------------------

const sandboxLsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list (default: /workspace)" })),
});

export function createSandboxLsTool(sandbox: SandboxInstance) {
	return {
		name: "sandbox_ls" as const,
		label: "sandbox_ls",
		description: "List files in the sandbox container filesystem.",
		parameters: sandboxLsSchema,
		execute: async (_id: string, { path }: Static<typeof sandboxLsSchema>) => {
			const dir = path || "/workspace";
			const result = await sandbox.exec(`ls -la ${dir}`);
			return { content: [{ type: "text" as const, text: result.stdout || "(empty)" }], details: {} };
		},
	};
}

// ---------------------------------------------------------------------------
// sandbox_read
// ---------------------------------------------------------------------------

const sandboxReadSchema = Type.Object({
	path: Type.String({ description: "Path to the file in the sandbox" }),
});

export function createSandboxReadTool(sandbox: SandboxInstance) {
	return {
		name: "sandbox_read" as const,
		label: "sandbox_read",
		description: "Read a text file from the sandbox container.",
		parameters: sandboxReadSchema,
		execute: async (_id: string, { path }: Static<typeof sandboxReadSchema>) => {
			const file = await sandbox.readFile(path);
			return { content: [{ type: "text" as const, text: file.content }], details: {} };
		},
	};
}

// ---------------------------------------------------------------------------
// sandbox_write
// ---------------------------------------------------------------------------

const sandboxWriteSchema = Type.Object({
	path: Type.String({ description: "Path to write in the sandbox" }),
	content: Type.String({ description: "Content to write" }),
});

export function createSandboxWriteTool(sandbox: SandboxInstance) {
	return {
		name: "sandbox_write" as const,
		label: "sandbox_write",
		description: "Write a text file to the sandbox container.",
		parameters: sandboxWriteSchema,
		execute: async (_id: string, { path, content }: Static<typeof sandboxWriteSchema>) => {
			const dir = path.substring(0, path.lastIndexOf("/"));
			if (dir) await sandbox.mkdir(dir, { recursive: true });
			await sandbox.writeFile(path, content);
			return {
				content: [{ type: "text" as const, text: `Wrote ${content.length} bytes to ${path}` }],
				details: {},
			};
		},
	};
}
