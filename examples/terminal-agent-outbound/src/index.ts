export default {
	async fetch(request: Request): Promise<Response> {
		return globalThis.fetch(request);
	},
};
