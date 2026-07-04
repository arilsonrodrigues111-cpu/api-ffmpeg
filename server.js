const express = require("express");
const { exec } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.json({ limit: "50mb" }));
app.use("/videos", express.static(path.join(__dirname, "public/videos")));

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || "";

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "API FFmpeg online"
  });
});

app.post("/render/image", async (req, res) => {
  const id = crypto.randomBytes(8).toString("hex");

  const imageUrl = req.body.image_url;
  const duration = Number(req.body.duration || 6);

  if (!imageUrl) {
    return res.status(400).json({
      ok: false,
      error: "Envie image_url"
    });
  }

  const outputPath = path.join(__dirname, "public/videos", `${id}.mp4`);

  const command = [
    "ffmpeg",
    "-y",
    "-loop 1",
    `-i "${imageUrl}"`,
    `-t ${duration}`,
    `-vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,zoompan=z='min(zoom+0.0015,1.15)':d=${duration * 30}:s=1080x1920:fps=30"`,
    "-c:v libx264",
    "-pix_fmt yuv420p",
    `"${outputPath}"`
  ].join(" ");

  exec(command, { timeout: 120000 }, (error, stdout, stderr) => {
    if (error) {
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
});

app.listen(PORT, () => {
  console.log(`API FFmpeg rodando na porta ${PORT}`);
});