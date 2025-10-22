import express from "express";
import axios from "axios";

const app = express();
const PORT = 3000;

const FIXED_BLOG_REFERER = "https://megacloud.blog/";
const FIXED_BLOG_ORIGIN = "https://megacloud.blog";

app.get("/proxy", async (req, res) => {
  try {
    const target = req.query.url;
    if (!target) return res.status(400).json({ error: "Missing url param" });

    const range = req.headers.range;
    const userAgent = req.headers["user-agent"] || "Mozilla/5.0";

    const defaultHeaders = {
      "User-Agent": userAgent,
      Accept: "*/*",
      "Accept-Encoding": "gzip, deflate, br",
      "Accept-Language": "en-US,en;q=0.5",
      Connection: "keep-alive",
      ...(range && { Range: range }),
    };

    const tryOrder = [
      { referer: null, origin: null },
      { referer: FIXED_BLOG_REFERER, origin: FIXED_BLOG_ORIGIN },
    ];

    let response;
    let proxySource = "direct";

    for (const attempt of tryOrder) {
      const parsed = new URL(target);
      const headers = {
        ...defaultHeaders,
        Referer: attempt.referer ?? `${parsed.protocol}//${parsed.hostname}/`,
        Origin: attempt.origin ?? `${parsed.protocol}//${parsed.hostname}`,
      };

      console.log(`[Proxy] Trying fetch with Referer=${headers.Referer}`);

      try {
        response = await axios.get(target, {
          headers,
          responseType: "stream",
          validateStatus: () => true,
        });
        proxySource = attempt.referer ? "megacloud.blog" : "direct";
      } catch (err) {
        console.warn(`[Proxy] Fetch failed: ${err.message}`);
        response = { status: 403, headers: {}, data: null };
      }

      if (response.status !== 403) break;
    }

    const contentType = response.headers["content-type"] || "";
    const status = response.status;

    // Handle playlists (.m3u8)
    if (contentType.includes("mpegurl") || target.endsWith(".m3u8")) {
      let chunks = [];
      response.data.on("data", (chunk) => chunks.push(chunk));
      response.data.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        const base = new URL(target);

        const rewritten = text.replace(/^(?!#)(.+)$/gm, (line) => {
          try {
            const abs = new URL(line, base).href;
            return `/proxy?url=${encodeURIComponent(abs)}`;
          } catch {
            return line;
          }
        });

        console.log(`[Proxy] Served playlist (${status}) via ${proxySource}`);
        res.set({
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
          "X-Proxy-Source": proxySource,
        });
        res.status(status).send(rewritten);
      });
      return;
    }

    // Stream segments chunk by chunk
    let totalBytes = 0;
    response.data.on("data", (chunk) => {
      totalBytes += chunk.length;
      console.log(`[Proxy] Streaming chunk: ${chunk.length} bytes (total ${totalBytes} bytes)`);
    });
    response.data.on("end", () => {
      console.log(`[Proxy] Finished streaming (${totalBytes} bytes) via ${proxySource}`);
    });

    res.set({
      "Content-Type": contentType || "video/MP2T",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "X-Proxy-Source": proxySource,
      "Accept-Ranges": "bytes",
      ...(response.headers["content-range"] && { "Content-Range": response.headers["content-range"] }),
    });

    response.data.pipe(res);

  } catch (err) {
    console.error("[Proxy] Fatal error:", err);
    res.status(500).json({ error: "Proxy error", details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🔥 Axios streaming proxy running at http://localhost:${PORT}/proxy?url=...`);
});
