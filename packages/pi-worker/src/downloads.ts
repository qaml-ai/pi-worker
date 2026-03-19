/**
 * Signed download URLs backed by R2.
 *
 * Store files → get time-limited signed URLs.
 * Serve download requests → verify signature + stream from R2.
 */

const DEFAULT_TTL_SECONDS = 30 * 60; // 30 minutes
const DOWNLOAD_PATH = "/download/";

async function hmac(secret: string, data: string): Promise<string> {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw", enc.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false, ["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface StoreOptions {
	/** MIME type. Default: application/octet-stream */
	contentType?: string;
	/** Download filename. Default: derived from key. */
	filename?: string;
	/** TTL in seconds. Default: 1800 (30 min). */
	ttl?: number;
}

export interface DownloadHandler {
	/**
	 * Store a file in R2 and return a signed download URL.
	 *
	 * @param key - R2 key to store under
	 * @param data - File content (string, ArrayBuffer, Uint8Array, or ReadableStream)
	 * @param options - Content type, filename, TTL
	 * @returns Signed URL string
	 */
	store: (
		key: string,
		data: string | ArrayBuffer | Uint8Array | ReadableStream,
		options?: StoreOptions,
	) => Promise<string>;

	/**
	 * Handle an incoming request. If it's a valid signed download request,
	 * returns the file as a Response. Otherwise returns null.
	 *
	 * Call this first in your fetch handler:
	 * ```ts
	 * const served = await downloads.serve(request);
	 * if (served) return served;
	 * ```
	 */
	serve: (request: Request) => Promise<Response | null>;
}

/**
 * Create a download handler backed by R2 with HMAC-signed URLs.
 *
 * @param bucket - R2 bucket for file storage
 * @param secret - Secret key for HMAC signing
 * @param basePath - URL path prefix for downloads. Default: "/download/"
 *
 * @example
 * ```ts
 * const downloads = createDownloadHandler(env.FILES, env.DOWNLOAD_SECRET);
 *
 * // Store and get URL
 * const url = await downloads.store("outputs/result.gif", gifBytes, {
 *   contentType: "image/gif",
 * });
 *
 * // Serve downloads (in your fetch handler)
 * const served = await downloads.serve(request);
 * if (served) return served;
 * ```
 */
export function createDownloadHandler(
	bucket: R2Bucket,
	secret: string,
	basePath = DOWNLOAD_PATH,
): DownloadHandler {

	const store = async (
		key: string,
		data: string | ArrayBuffer | Uint8Array | ReadableStream,
		options?: StoreOptions,
	): Promise<string> => {
		const contentType = options?.contentType || "application/octet-stream";
		const filename = options?.filename || key.split("/").pop() || "download";
		const ttl = options?.ttl ?? DEFAULT_TTL_SECONDS;

		await bucket.put(key, data, {
			httpMetadata: {
				contentType,
				contentDisposition: `attachment; filename="${filename}"`,
			},
		});

		const expires = Date.now() + ttl * 1000;
		const sig = await hmac(secret, `${key}:${expires}`);
		// Return a relative URL — the caller can prepend the origin if needed
		return `${basePath}${encodeURIComponent(key)}?expires=${expires}&sig=${sig}`;
	};

	const serve = async (request: Request): Promise<Response | null> => {
		if (request.method !== "GET") return null;

		const url = new URL(request.url);
		if (!url.pathname.startsWith(basePath)) return null;

		const key = decodeURIComponent(url.pathname.slice(basePath.length));
		const expires = url.searchParams.get("expires");
		const sig = url.searchParams.get("sig");

		if (!expires || !sig) {
			return new Response("Missing signature", { status: 403 });
		}

		const expiresMs = parseInt(expires, 10);
		if (isNaN(expiresMs) || Date.now() > expiresMs) {
			return new Response("Link expired", { status: 403 });
		}

		const expected = await hmac(secret, `${key}:${expires}`);
		if (expected !== sig) {
			return new Response("Invalid signature", { status: 403 });
		}

		const obj = await bucket.get(key);
		if (!obj) return new Response("Not found", { status: 404 });

		return new Response(obj.body, {
			headers: {
				"content-type": obj.httpMetadata?.contentType || "application/octet-stream",
				"content-disposition": obj.httpMetadata?.contentDisposition || "attachment",
				"cache-control": "private, no-store",
			},
		});
	};

	return { store, serve };
}
