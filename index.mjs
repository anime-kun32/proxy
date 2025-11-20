// api/proxy.js
import axios from "axios";

const BLOG_HOST = "megacloud.blog";
const FIXED_BLOG_REFERER = `https://${BLOG_HOST}/`;
const FIXED_BLOG_ORIGIN = `https://${BLOG_HOST}`;

export default async function handler(req, res) {
  try {
    const target = req.query.url;
    console.log("[Proxy] Incoming request for URL:", target);

    if (!target) {
      console.warn("[Proxy] Missing URL parameter");
      return res.status(400).json({ error: "Missing ?url=" });
    }

    const parsed = new URL(target);
    const range = req.headers.range;

    const headers = {
      "User-Agent":
        req.headers["user-agent"] ||
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      Accept: "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: FIXED_BLOG_REFERER,
      Origin: FIXED_BLOG_ORIGIN,
      Host: parsed.hostname,
      ...(range && { Range: range }),
    };

    console.log("[Proxy] Request headers:", headers);

    const response = await axios.get(parsed.href, {
      headers,
      responseType: "stream",
      validateStatus: () => true, // don't throw on 403/404
    });

    const contentType = response.headers["content-type"] || "";
    const status = response.status;

    console.log(`[Proxy] Upstream status: ${status}, Content-Type: ${contentType}`);

    // Handle playlists
    if (contentType.includes("mpegurl") || parsed.pathname.endsWith(".m3u8")) {
      console.log("[Proxy] Detected playlist, rewriting...");
      const chunks = [];
      response.data.on("data", (chunk) => chunks.push(chunk));
      response.data.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        const base = parsed;

        const rewritten = text.replace(/^(?!#)(.+)$/gm, (line) => {
          try {
            const abs = new URL(line, base).href;
            console.log("[Proxy] Rewriting playlist line:", line, "→", abs);
            return `/api/proxy?url=${encodeURIComponent(abs)}`;
          } catch {
            return line;
          }
        });

        console.log("[Proxy] Finished rewriting playlist");
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Access-Control-Allow-Origin", "*");
        return res.status(status).send(rewritten);
      });
      return;
    }

    // Stream binary content
    console.log("[Proxy] Streaming binary/video content");
    let totalBytes = 0;
    response.data.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes % (1024 * 512) === 0) {
        console.log(`[Proxy] Streamed ~${Math.round(totalBytes / 1024)} KB`);
      }
    });
    response.data.on("end", () => {
      console.log(`[Proxy] Stream finished (${totalBytes} bytes)`);
    });

    res.setHeader("Content-Type", contentType || "video/MP2T");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Accept-Ranges", "bytes");
    if (response.headers["content-range"]) {
      res.setHeader("Content-Range", response.headers["content-range"]);
    }

    response.data.pipe(res);
  } catch (err) {
    console.error("[Proxy] Fatal error:", err);
    res.status(500).json({ error: "Proxy error", details: err.message });
  }
}
