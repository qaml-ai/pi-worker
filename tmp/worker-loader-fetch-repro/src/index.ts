import { createExecuteTool } from "pi-worker";

interface Env {
  LOADER: any;
  OUTBOUND: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/run") {
      return new Response("ok");
    }

    const tool = createExecuteTool(env.LOADER, {}, {
      globalOutbound: env.OUTBOUND,
      outboundBinding: env.OUTBOUND,
    });

    const result = await tool.execute("repro", {
      code: [
        'const response = await fetch("https://example.com");',
        "return {",
        "  status: response.status,",
        "  contentType: response.headers.get(\"content-type\"),",
        "};",
      ].join("\n"),
    });

    return Response.json(result);
  },
};
