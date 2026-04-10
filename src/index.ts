export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const assetResponse = await env.ASSETS.fetch(request);
    const contentType = assetResponse.headers.get("content-type") || "";

    // Only template HTML responses; pass through everything else (data.json, fonts, etc.)
    if (!contentType.includes("text/html")) {
      return assetResponse;
    }

    // Fetch data.json from the same asset bundle so the count is always in sync
    let totalAssessed: string;
    try {
      const dataUrl = new URL("/data.json", request.url);
      const dataResponse = await env.ASSETS.fetch(new Request(dataUrl.toString()));
      if (!dataResponse.ok) throw new Error("data.json fetch failed");
      const data: any = await dataResponse.json();
      totalAssessed = String(data.metadata.total_assessed);
    } catch (err) {
      // Graceful fallback: if data.json is broken or missing, leave a sane number
      // rather than rendering "__TOTAL_ASSESSED__" to users. This is a backstop
      // for the JSON-validation rule, not a substitute for it.
      totalAssessed = "55";
    }

    const html = await assetResponse.text();
    const rendered = html.replaceAll("__TOTAL_ASSESSED__", totalAssessed);

    // Preserve original headers but ensure no stale cache pins the old count.
    const headers = new Headers(assetResponse.headers);
    headers.set("cache-control", "public, max-age=60");

    return new Response(rendered, {
      status: assetResponse.status,
      statusText: assetResponse.statusText,
      headers,
    });
  },
};
