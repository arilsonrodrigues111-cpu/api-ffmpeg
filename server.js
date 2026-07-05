const express = require("express");
const { execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.json({ limit: "100mb" }));

const PORT = process.env.PORT || 80;
const BASE_URL = process.env.BASE_URL || "";

const videosDir = path.join(__dirname, "public/videos");
fs.mkdirSync(videosDir, { recursive: true });

app.use("/videos", express.static(videosDir));

const MAX_VIDEO_AGE_MS = 2 * 60 * 60 * 1000; // 2 horas
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutos

function getVideoUrl(fileName) {
  return BASE_URL ? `${BASE_URL}/videos/${fileName}` : `/videos/${fileName}`;
}

function safeDelete(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    console.error(`Erro ao apagar ${filePath}:`, err.message);
  }
}

function safeRemoveDir(dirPath) {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  } catch (err) {
    console.error(`Erro ao apagar pasta ${dirPath}:`, err.message);
  }
}

function cleanupOldVideos() {
  try {
    const files = fs.readdirSync(videosDir);
    const now = Date.now();

    for (const file of files) {
      if (!file.endsWith(".mp4")) continue;

      const filePath = path.join(videosDir, file);
      const stats = fs.statSync(filePath);
      const age = now - stats.mtimeMs;

      if (age > MAX_VIDEO_AGE_MS) {
        fs.unlinkSync(filePath);
        console.log(`Vídeo antigo apagado: ${file}`);
      }
    }
  } catch (err) {
    console.error("Erro na limpeza de vídeos:", err.message);
  }
}

async function downloadFile(url, outputPath) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0"
    }
  });

  if (!response.ok) {
    throw new Error(`Não consegui baixar: ${url} | status ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(outputPath, Buffer.from(arrayBuffer));
}

function runFfmpeg(args, timeoutMs = 600000) {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        return reject(new Error(stderr || error.message));
      }

      resolve({ stdout, stderr });
    });
  });
}

function buildZoomFilter(duration, zoomEnd) {
  const fps = 30;
  const frames = Math.round(duration * fps);
  const framesMinusOne = Math.max(frames - 1, 1);
  const zoomDelta = zoomEnd - 1;

  return [
    "scale=2160:3840:force_original_aspect_ratio=increase",
    "crop=2160:3840",
    "setsar=1",
    `zoompan=z='1+${zoomDelta}*on/${framesMinusOne}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1080x1920:fps=${fps}`,
    "format=yuv420p"
  ].join(",");
}

async function renderImageScene(inputPath, outputPath, duration, zoomEnd) {
  const vf = buildZoomFilter(duration, zoomEnd);

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

  await runFfmpeg(args);
}

async function normalizeVideoScene(inputPath, outputPath) {
  const args = [
    "-y",
    "-i", inputPath,
    "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,format=yuv420p",
    "-r", "30",
    "-an",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    outputPath
  ];

  await runFfmpeg(args);
}

function escapeConcatPath(filePath) {
  return filePath.replace(/'/g, "'\\''");
}

async function concatVideos(scenePaths, listPath, outputPath) {
  const listContent = scenePaths
    .map((scenePath) => `file '${escapeConcatPath(scenePath)}'`)
    .join("\n");

  fs.writeFileSync(listPath, listContent);

  const argsCopy = [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,
    "-c", "copy",
    outputPath
  ];

  try {
    await runFfmpeg(argsCopy);
  } catch (err) {
    console.log("Concat com copy falhou. Tentando reencodar...");

    const argsReencode = [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-vf", "scale=1080:1920,setsar=1,format=yuv420p",
      "-r", "30",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      outputPath
    ];

    await runFfmpeg(argsReencode);
  }
}

function parseTimeToSeconds(timeText) {
  const clean = String(timeText).trim().replace(",", ".");
  const parts = clean.split(":");

  if (parts.length !== 3) return 0;

  const hours = Number(parts[0]);
  const minutes = Number(parts[1]);
  const seconds = Number(parts[2]);

  return hours * 3600 + minutes * 60 + seconds;
}

function parseSrtToCaptions(srtText) {
  const blocks = String(srtText)
    .replace(/\r/g, "")
    .split(/\n\s*\n/)
    .filter(Boolean);

  const captions = [];

  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const timeLineIndex = lines.findIndex((line) => line.includes("-->"));

    if (timeLineIndex === -1) continue;

    const timeLine = lines[timeLineIndex];
    const [startText, endText] = timeLine.split("-->").map((part) => part.trim());

    const textLines = lines.slice(timeLineIndex + 1);
    const text = textLines.join(" ").trim();

    if (!text) continue;

    captions.push({
      start: parseTimeToSeconds(startText),
      end: parseTimeToSeconds(endText),
      text
    });
  }

  return captions;
}

function formatAssTime(seconds) {
  const totalCentiseconds = Math.max(0, Math.round(Number(seconds) * 100));

  const hours = Math.floor(totalCentiseconds / 360000);
  const minutes = Math.floor((totalCentiseconds % 360000) / 6000);
  const secs = Math.floor((totalCentiseconds % 6000) / 100);
  const centis = totalCentiseconds % 100;

  return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(centis).padStart(2, "0")}`;
}

function escapeAssText(text) {
  return String(text)
    .replace(/[{}]/g, "")
    .replace(/\\/g, "")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function assColorFromHex(value, fallback = "&H00FFFFFF") {
  if (!value) return fallback;

  const raw = String(value).trim();

  if (/^&H[0-9A-Fa-f]{8}$/.test(raw)) {
    return raw.toUpperCase();
  }

  const clean = raw.replace("#", "");

  if (!/^[0-9A-Fa-f]{6}$/.test(clean)) {
    return fallback;
  }

  const rr = clean.slice(0, 2);
  const gg = clean.slice(2, 4);
  const bb = clean.slice(4, 6);

  return `&H00${bb}${gg}${rr}`.toUpperCase();
}

function assBackColorFromHex(value, fallback = "&H88000000", alpha = "88") {
  if (!value) return fallback;

  const raw = String(value).trim();

  if (/^&H[0-9A-Fa-f]{8}$/.test(raw)) {
    return raw.toUpperCase();
  }

  const rgbaMatch = raw.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/i);

  if (rgbaMatch) {
    const r = Math.max(0, Math.min(255, Number(rgbaMatch[1]))).toString(16).padStart(2, "0");
    const g = Math.max(0, Math.min(255, Number(rgbaMatch[2]))).toString(16).padStart(2, "0");
    const b = Math.max(0, Math.min(255, Number(rgbaMatch[3]))).toString(16).padStart(2, "0");
    const opacity = rgbaMatch[4] === undefined ? 0.45 : Math.max(0, Math.min(1, Number(rgbaMatch[4])));

    // ASS alpha: 00 = opaco, FF = transparente
    const assAlpha = Math.round((1 - opacity) * 255).toString(16).padStart(2, "0");

    return `&H${assAlpha}${b}${g}${r}`.toUpperCase();
  }

  const clean = raw.replace("#", "");

  if (!/^[0-9A-Fa-f]{6}$/.test(clean)) {
    return fallback;
  }

  const rr = clean.slice(0, 2);
  const gg = clean.slice(2, 4);
  const bb = clean.slice(4, 6);

  return `&H${alpha}${bb}${gg}${rr}`.toUpperCase();
}

function assInlineColorFromHex(value, fallback = "&HFFFFFF&") {
  if (!value) return fallback;

  const raw = String(value).trim();

  if (/^&H[0-9A-Fa-f]{6}&$/.test(raw)) {
    return raw.toUpperCase();
  }

  if (/^&H[0-9A-Fa-f]{8}$/.test(raw)) {
    const withoutAlpha = raw.slice(4);
    return `&H${withoutAlpha}&`.toUpperCase();
  }

  const clean = raw.replace("#", "");

  if (!/^[0-9A-Fa-f]{6}$/.test(clean)) {
    return fallback;
  }

  const rr = clean.slice(0, 2);
  const gg = clean.slice(2, 4);
  const bb = clean.slice(4, 6);

  return `&H${bb}${gg}${rr}&`.toUpperCase();
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeFontName(fontName) {
  const clean = String(fontName || "DejaVu Sans")
    .replace(/[,\n\r]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return clean || "DejaVu Sans";
}

function wrapCaptionText(text, maxCharsPerLine = 26, maxLines = 2) {
  const words = escapeAssText(text).split(" ").filter(Boolean);
  const lines = [];
  let current = "";

  for (const word of words) {
    const test = current ? `${current} ${word}` : word;

    if (test.length <= maxCharsPerLine) {
      current = test;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }

  if (current) lines.push(current);

  if (lines.length <= maxLines) {
    return lines.join("\\N");
  }

  const limited = lines.slice(0, maxLines);
  return limited.join("\\N");
}

function highlightImportantWord(text, highlightColor) {
  const cleanText = String(text || "");

  const stopWords = new Set([
    "A", "O", "OS", "AS", "UM", "UMA", "UNS", "UMAS",
    "DE", "DA", "DO", "DAS", "DOS", "EM", "NO", "NA", "NOS", "NAS",
    "E", "OU", "QUE", "COM", "SEM", "PARA", "POR", "PRA",
    "MAIS", "MAS", "FOI", "ERA", "SÃO", "SAO", "SER", "TER",
    "ISSO", "ESSE", "ESSA", "ESTE", "ESTA", "ELE", "ELA",
    "HOJE", "AGORA", "MUNDO", "BRASIL", "PESSOAS"
  ]);

  const plainWords = cleanText
    .replace(/\\N/g, " ")
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}À-ÿ-]/gu, ""))
    .filter(Boolean);

  const chosen = plainWords.find((word) => {
    const upper = word.toUpperCase();
    return upper.length >= 5 && !stopWords.has(upper);
  });

  if (!chosen) return cleanText;

  const colorTag = `{\\c${highlightColor}}`;
  const whiteTag = "{\\c&HFFFFFF&}";

  const regex = new RegExp(escapeRegex(chosen), "i");

  return cleanText.replace(regex, `${colorTag}$&${whiteTag}`);
}

function createAssSubtitle(captions, outputPath, options = {}) {
  const fontSize = Number(options.caption_font_size || 76);
  const marginV = Number(options.caption_margin_v || 235);
  const uppercase = options.caption_uppercase !== false;
  const maxCharsPerLine = Number(options.caption_max_chars_per_line || 22);
  const maxLines = Number(options.caption_max_lines || 2);

  const fontFamily = sanitizeFontName(options.caption_font_family || "DejaVu Sans");

  const primaryColor = assColorFromHex(options.caption_font_color || "#FFFFFF", "&H00FFFFFF");
  const outlineColor = assColorFromHex(options.caption_stroke_color || "#090909", "&H00090909");
  const shadowColor = assBackColorFromHex(options.caption_shadow_color || "#000000", "&H70000000", "70");
  const boxColor = assBackColorFromHex(options.caption_box_color || "rgba(0,0,0,0.42)", "&H93000000");
  const highlightColor = assInlineColorFromHex(options.caption_highlight_color || "#FFD54A", "&H4AD5FF&");

  const outline = Number(options.caption_stroke_width || 5);
  const shadow = Number(options.caption_shadow_size || 3);
  const spacing = Number(options.caption_letter_spacing || 0);
  const fadeIn = Number(options.caption_fade_in_ms || 110);
  const fadeOut = Number(options.caption_fade_out_ms || 120);

  const boxEnabled = options.caption_box !== false;
  const highlightEnabled = options.caption_highlight_keywords !== false;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Text,${fontFamily},${fontSize},${primaryColor},&H000000FF,${outlineColor},${shadowColor},-1,0,0,0,100,100,${spacing},0,1,${outline},${shadow},2,78,78,${marginV},1
Style: Box,${fontFamily},${fontSize},&HFF000000,&HFF000000,&HFF000000,${boxColor},-1,0,0,0,100,100,${spacing},0,3,18,0,2,78,78,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  const events = captions
    .filter((caption) => Number(caption.end) > Number(caption.start))
    .flatMap((caption) => {
      const start = formatAssTime(caption.start);
      const end = formatAssTime(caption.end);

      let text = String(caption.text || "");
      if (uppercase) text = text.toUpperCase();

      const wrapped = wrapCaptionText(text, maxCharsPerLine, maxLines);
      const highlighted = highlightEnabled
        ? highlightImportantWord(wrapped, highlightColor)
        : wrapped;

      const fadeTag = `{\\fad(${fadeIn},${fadeOut})}`;

      const lines = [];

      // Camada 0: fundo preto translúcido elegante
      if (boxEnabled) {
        lines.push(`Dialogue: 0,${start},${end},Box,,0,0,0,,${fadeTag}${wrapped}`);
      }

      // Camada 1: texto principal com contorno, sombra e destaque
      lines.push(`Dialogue: 1,${start},${end},Text,,0,0,0,,${fadeTag}${highlighted}`);

      return lines;
    })
    .join("\n");

  fs.writeFileSync(outputPath, `${header}\n${events}\n`, "utf8");
}

function buildSubtitlePath(jobDir, body) {
  const assPath = path.join(jobDir, "legenda.ass");

  if (body.subtitle_ass) {
    fs.writeFileSync(assPath, String(body.subtitle_ass), "utf8");
    return assPath;
  }

  let captions = [];

  if (Array.isArray(body.captions)) {
    captions = body.captions;
  } else if (body.subtitle_srt) {
    captions = parseSrtToCaptions(body.subtitle_srt);
  }

  if (!captions || captions.length === 0) {
    return null;
  }

  createAssSubtitle(captions, assPath, body);

  return assPath;
}

function buildSubtitleFilter(subtitlePath) {
  return `subtitles=${subtitlePath}`;
}

async function muxFinalVideo({
  videoPath,
  outputPath,
  audioPath,
  musicPath,
  subtitlePath,
  musicVolume
}) {
  const hasAudio = Boolean(audioPath);
  const hasMusic = Boolean(musicPath);
  const hasSubtitle = Boolean(subtitlePath);

  const args = ["-y", "-i", videoPath];

  let audioIndex = null;
  let musicIndex = null;
  let inputIndex = 1;

  if (hasAudio) {
    args.push("-i", audioPath);
    audioIndex = inputIndex;
    inputIndex++;
  }

  if (hasMusic) {
    args.push("-stream_loop", "-1", "-i", musicPath);
    musicIndex = inputIndex;
    inputIndex++;
  }

  const filterParts = [];

  if (hasSubtitle) {
    filterParts.push(`[0:v]${buildSubtitleFilter(subtitlePath)}[vout]`);
  }

  if (hasAudio && hasMusic) {
    filterParts.push(`[${musicIndex}:a]volume=${musicVolume}[music]`);
    filterParts.push(`[${audioIndex}:a][music]amix=inputs=2:duration=first:dropout_transition=2[aout]`);
  } else if (!hasAudio && hasMusic) {
    filterParts.push(`[${musicIndex}:a]volume=${musicVolume}[aout]`);
  }

  if (filterParts.length > 0) {
    args.push("-filter_complex", filterParts.join(";"));
  }

  if (hasSubtitle) {
    args.push("-map", "[vout]");
  } else {
    args.push("-map", "0:v:0");
  }

  if (hasAudio && hasMusic) {
    args.push("-map", "[aout]");
  } else if (hasAudio && !hasMusic) {
    args.push("-map", `${audioIndex}:a:0`);
  } else if (!hasAudio && hasMusic) {
    args.push("-map", "[aout]");
  } else {
    args.push("-an");
  }

  args.push(
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p"
  );

  if (hasAudio || hasMusic) {
    args.push(
      "-c:a", "aac",
      "-b:a", "192k",
      "-shortest"
    );
  }

  args.push(
    "-movflags", "+faststart",
    outputPath
  );

  await runFfmpeg(args);
}

function normalizeImageScenes(body) {
  if (Array.isArray(body.images)) {
    return body.images;
  }

  if (Array.isArray(body.scenes)) {
    return body.scenes.filter((scene) => {
      return scene && typeof scene === "object" && scene.image_url;
    });
  }

  return [];
}

function normalizeVideoSceneUrls(body) {
  if (Array.isArray(body.scene_urls)) {
    return body.scene_urls;
  }

  if (Array.isArray(body.scenes)) {
    return body.scenes.filter((scene) => typeof scene === "string");
  }

  return [];
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "API FFmpeg online",
    routes: {
      image: "POST /render/image",
      final: "POST /render/final"
    },
    subtitles: {
      beautiful: "Use captions ou subtitle_srt para legenda bonita em ASS"
    }
  });
});

app.post("/render/image", async (req, res) => {
  const id = crypto.randomBytes(8).toString("hex");
  const inputPath = path.join("/tmp", `${id}.input`);
  const outputFileName = `${id}.mp4`;
  const outputPath = path.join(videosDir, outputFileName);

  try {
    const imageUrl = req.body.image_url;
    const duration = Number(req.body.duration || 6);
    const zoomEnd = Number(req.body.zoom_end || 1.08);

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

    await downloadFile(imageUrl, inputPath);
    await renderImageScene(inputPath, outputPath, duration, zoomEnd);

    return res.json({
      ok: true,
      video_url: getVideoUrl(outputFileName),
      expires_in_hours: 2
    });
  } catch (err) {
    console.error("Erro /render/image:", err.message);
    safeDelete(outputPath);

    return res.status(500).json({
      ok: false,
      error: "Erro ao gerar vídeo da imagem",
      details: err.message
    });
  } finally {
    safeDelete(inputPath);
  }
});

app.post("/render/final", async (req, res) => {
  const jobId = crypto.randomBytes(8).toString("hex");
  const jobDir = path.join("/tmp", `job-${jobId}`);
  fs.mkdirSync(jobDir, { recursive: true });

  const outputFileName = `${jobId}-final.mp4`;
  const outputPath = path.join(videosDir, outputFileName);

  try {
    const imageScenes = normalizeImageScenes(req.body);
    const videoSceneUrls = normalizeVideoSceneUrls(req.body);

    const audioUrl = req.body.audio_url || null;
    const musicUrl = req.body.music_url || null;
    const musicVolume = Number(req.body.music_volume || 0.07);

    if (imageScenes.length === 0 && videoSceneUrls.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "Envie images ou scene_urls"
      });
    }

    const scenePaths = [];

    for (let i = 0; i < imageScenes.length; i++) {
      const scene = imageScenes[i];

      const imageUrl = scene.image_url;
      const duration = Number(scene.duration || req.body.default_scene_duration || 6);
      const zoomEnd = Number(scene.zoom_end || req.body.default_zoom_end || 1.08);

      if (!imageUrl) {
        throw new Error(`Cena ${i + 1} está sem image_url`);
      }

      const inputImagePath = path.join(jobDir, `image-${i + 1}.input`);
      const sceneVideoPath = path.join(jobDir, `scene-${i + 1}.mp4`);

      await downloadFile(imageUrl, inputImagePath);
      await renderImageScene(inputImagePath, sceneVideoPath, duration, zoomEnd);

      scenePaths.push(sceneVideoPath);
    }

    for (let i = 0; i < videoSceneUrls.length; i++) {
      const sceneUrl = videoSceneUrls[i];

      const inputVideoPath = path.join(jobDir, `input-video-${i + 1}.mp4`);
      const normalizedVideoPath = path.join(jobDir, `normalized-video-${i + 1}.mp4`);

      await downloadFile(sceneUrl, inputVideoPath);
      await normalizeVideoScene(inputVideoPath, normalizedVideoPath);

      scenePaths.push(normalizedVideoPath);
    }

    const listPath = path.join(jobDir, "scenes.txt");
    const concatPath = path.join(jobDir, "concat.mp4");

    await concatVideos(scenePaths, listPath, concatPath);

    let audioPath = null;
    let musicPath = null;

    if (audioUrl) {
      audioPath = path.join(jobDir, "narracao.audio");
      await downloadFile(audioUrl, audioPath);
    }

    if (musicUrl) {
      musicPath = path.join(jobDir, "musica.audio");
      await downloadFile(musicUrl, musicPath);
    }

    const subtitlePath = buildSubtitlePath(jobDir, req.body);

    await muxFinalVideo({
      videoPath: concatPath,
      outputPath,
      audioPath,
      musicPath,
      subtitlePath,
      musicVolume
    });

    return res.json({
      ok: true,
      video_url: getVideoUrl(outputFileName),
      scenes_count: scenePaths.length,
      subtitles: subtitlePath ? "beautiful_ass" : "none",
      expires_in_hours: 2
    });
  } catch (err) {
    console.error("Erro /render/final:", err.message);
    safeDelete(outputPath);

    return res.status(500).json({
      ok: false,
      error: "Erro ao gerar vídeo final",
      details: err.message
    });
  } finally {
    safeRemoveDir(jobDir);
  }
});

cleanupOldVideos();
setInterval(cleanupOldVideos, CLEANUP_INTERVAL_MS);

app.listen(PORT, () => {
  console.log(`API FFmpeg rodando na porta ${PORT}`);
  console.log("POST /render/image");
  console.log("POST /render/final");
  console.log("Legenda bonita ativada via captions, subtitle_srt ou subtitle_ass.");
  console.log("Limpeza automática ativada: vídeos com mais de 2 horas serão apagados.");
});
