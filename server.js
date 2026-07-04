const express = require("express");
const { execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 80;
const BASE_URL = process.env.BASE_URL || "";

const videosDir = path.join(__dirname, "public/videos");
fs.mkdirSync(videosDir, { recursive: true });

app.use("/videos", express.static(videosDir));

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "API FFmpeg online"
  });
});

app.post("/render/image", async (req, res) => {
  try {
    const id = crypto.randomBytes(8).toString("hex");

    const imageUrl = req.body.image_url;
    const duration = Number(req.body.duration || 6);
    const zoomEnd = Number(req.body.zoom_end || 1.15);

    if (!imageUrl) {
      return res.status(400).json({
        ok: false,
        error: "Envie image_url"
      });
    }

    if (duration <= 0) {
      return res.status(400).json({
        ok: false,
        error: "duration precisa ser maior que 0"
      });
    }

    if (zoomEnd < 1) {
      return res.status(400).json({
        ok: false,
        error: "zoom_end precisa ser maior ou igual a 1"
      });
    }

    const inputPath = path.join("/tmp", `${id}.jpg`);
    const outputPath = path.join(videosDir, `${id}.mp4`);

    // Baixa a imagem primeiro
    const response = await fetch(imageUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    if (!response.ok) {
      return res.status(400).json({
        ok: false,
        error: "Não consegui baixar a imagem",
        status: response.status
      });
    }

    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(inputPath, Buffer.from(arrayBuffer));

    const fps = 30;
    const frames = Math.round(duration * fps);

    // Faz o zoom durar a cena inteira
    const zoomStep = (zoomEnd - 1) / frames;

    const vf = [
      "scale=1080:1920:force_original_aspect_ratio=increase",
      "crop=1080:1920",
      `zoompan=z='min(zoom+${zoomStep},${zoomEnd})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1080x1920:fps=${fps}`
    ].join(",");

    const args = [
      "-y",
      "-loop", "1",
      "-i", inputPath,
      "-t", String(duration),
      "-vf", vf,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      outputPath
    ];

    execFile("ffmpeg", args, { timeout: 120000 }, (error, stdout, stderr) => {
      try {
        if (fs.existsSync(inputPath)) {
          fs.unlinkSync(inputPath);
        }
      } catch (e) {}

      if (error) {
        console.error("Erro FFmpeg:", stderr || error.message);

        return res.status(500).json({
          ok: false,
          error: "Erro ao gerar vídeo",
          details: stderr || error.message
        });
      }

      const videoUrl = BASE_URL
        ? `${BASE_URL}/videos/${id}.mp4`
        : `/videos/${id}.mp4`;

      return res.json({
        ok: true,
        video_url: videoUrl
      });
    });
  } catch (err) {
    console.error("Erro geral:", err);

    return res.status(500).json({
      ok: false,
      error: "Erro interno",
      details: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`API FFmpeg rodando na porta ${PORT}`);
});
