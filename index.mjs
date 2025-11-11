import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import dns from "dns";
import https from "https";
import cors from "cors";

dotenv.config();

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const BLOG_HOST = process.env.BLOG_HOST || "megacloud.blog";
const FIXED_BLOG_REFERER = `https://${BLOG_HOST}/`;
const FIXED_BLOG_ORIGIN = `https://${BLOG_HOST}`;

// IPv4-only DNS with fallback
const safeLookup = (hostname, options, cb) => {
  if (!hostname) {
    console.warn("[Proxy] ⚠️ Hostname undefined for lookup");
    return cb(null, "127.0.0.1", 4);
  }
  dns.lookup(hostname, { family: 4 }, (err, address, family) => {
    if (err) {
      console.warn(`[Proxy] DNS lookup failed for ${hostname}: ${err.message}`);
      return cb(null, "127.0.0.1", 4);
    }
    cb(null, address, family);
  });
};

const httpsAgent = new https.Agent({ lookup: safeLookup });

app.get("/proxy", async (req, res) => {
  try {
    const target = req.query.url;
    if (!target) return res.status(400).json({ error: "Missing url param" });

    const parsed = new URL(target);
    const range = req.headers.range;
    const userAgent =
      req.headers["user-agent"] ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

    console.log(`[Proxy] Incoming from: ${req.headers.host}`);

    const headers = {
      "User-Agent": userAgent,
      Accept: "*/*",
      "Accept-Encoding": "gzip, deflate, br",
      "Accept-Language": "en-US,en;q=0.9",
      Connection: "keep-alive",
      Referer: FIXED_BLOG_REFERER,
      Origin: FIXED_BLOG_ORIGIN,
      Host: parsed.hostname,
      ...(range && { Range: range }),
    };

    console.log(`[Proxy] Fetch attempt → ${parsed.href} (Referer=${FIXED_BLOG_REFERER})`);

    const response = await axios.get(parsed.href, {
      headers,
      responseType: "stream",
      httpsAgent,
      validateStatus: () => true,
    });

    const contentType = response.headers["content-type"] || "";
    const status = response.status;

    if (!response.data) {
      console.error("[Proxy] ⚠️ No response stream available");
      return res.status(status || 502).json({ error: "No stream" });
    }

    // Handle playlists
    if (contentType.includes("mpegurl") || target.endsWith(".m3u8")) {
      const chunks = [];
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

        console.log(`[Proxy] Served playlist (${status})`);
        res.set({
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
          "X-Proxy-Source": BLOG_HOST,
        });
        res.status(status).send(rewritten);
      });
      return;
    }

    // Stream chunks
    let totalBytes = 0;
    response.data.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes % (1024 * 512) === 0)
        console.log(`[Proxy] Streamed ${Math.round(totalBytes / 1024)}KB`);
    });
    response.data.on("end", () => {
      console.log(`[Proxy] Stream finished (${totalBytes} bytes)`);
    });

    res.set({
      "Content-Type": contentType || "video/MP2T",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "X-Proxy-Source": BLOG_HOST,
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
  console.log(`🚀 Proxy running at http://localhost:${PORT}/proxy?url=...`);
});
