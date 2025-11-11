import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import dns from "dns";
import https from "https";
import cors from "cors"; // 🧩 new

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// 🧩 allow all origins (or lock it to your site later)
app.use(
  cors({
    origin: "*",
    methods: ["GET", "HEAD", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Range", "User-Agent", "Origin"],
    exposedHeaders: ["Content-Range", "X-Proxy-Source"],
  })
);

// Default fallback values
const BLOG_HOST = process.env.BLOG_HOST || "megacloud.blog";
const FIXED_BLOG_REFERER = `https://${BLOG_HOST}/`;
const FIXED_BLOG_ORIGIN = `https://${BLOG_HOST}`;

app.get("/proxy", async (req, res) => {
  try {
    const target = req.query.url;
    if (!target) return res.status(400).json({ error: "Missing url param" });

    const range = req.headers.range;
    const userAgent =
      req.headers["user-agent"] ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

    const userHost =
      req.headers.origin?.replace(/^https?:\/\//, "") ||
      req.headers.host ||
      BLOG_HOST;

    console.log(`[Proxy] Incoming from: ${userHost}`);

    const defaultHeaders = {
      "User-Agent": userAgent,
      Accept: "*/*",
      "Accept-Encoding": "gzip, deflate, br",
      "Accept-Language": "en-US,en;q=0.9",
      Connection: "keep-alive",
      DNT: "1",
      Pragma: "no-cache",
      ...(range && { Range: range }),
    };

    const tryOrder = [
      { referer: null, origin: null },
      { referer: FIXED_BLOG_REFERER, origin: FIXED_BLOG_ORIGIN },
    ];

    let response;
    let proxySource = "direct";

    const httpsAgent = new https.Agent({
      lookup: (hostname, options, cb) => dns.lookup(hostname, { family: 4 }, cb),
    });

    for (const attempt of tryOrder) {
      const parsed = new URL(target);
      const headers = {
        ...defaultHeaders,
        Host: parsed.hostname,
        Referer: attempt.referer ?? `${parsed.protocol}//${parsed.hostname}/`,
        Origin: attempt.origin ?? `${parsed.protocol}//${parsed.hostname}`,
      };

      console.log(`[Proxy] Fetch attempt → ${headers.Referer}`);

      try {
        response = await axios.get(target, {
          headers,
          responseType: "stream",
          httpsAgent,
          validateStatus: () => true,
        });
        proxySource = attempt.referer ? BLOG_HOST : "direct";
      } catch (err) {
        console.warn(`[Proxy] Fetch failed: ${err.message}`);
        response = { status: 403, headers: {}, data: null };
      }

      if (response.status !== 403) break;
    }

    const contentType = response.headers["content-type"] || "";
    const status = response.status;

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

    let totalBytes = 0;
    response.data.on("data", (chunk) => {
      totalBytes += chunk.length;
      console.log(`[Proxy] Stream chunk ${chunk.length} bytes (total ${totalBytes})`);
    });
    response.data.on("end", () => {
      console.log(`[Proxy] Finished stream (${totalBytes} bytes) via ${proxySource}`);
    });

    res.set({
      "Content-Type": contentType || "video/MP2T",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "X-Proxy-Source": proxySource,
      "Accept-Ranges": "bytes",
      ...(response.headers["content-range"] && {
        "Content-Range": response.headers["content-range"],
      }),
    });

    response.data.pipe(res);
  } catch (err) {
    console.error("[Proxy] Fatal:", err);
    res.status(500).json({ error: "Proxy error", details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Proxy ready at http://localhost:${PORT}/proxy?url=...`);
});
