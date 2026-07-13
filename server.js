const express = require("express");
const { execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.json({ limit: "100mb" }));

const PORT = Number(process.env.PORT || 80);
const BASE_URL = String(process.env.BASE_URL || "").replace(/\/$/, "");
const FONTS_DIR = process.env.FONTS_DIR
  ? path.resolve(process.env.FONTS_DIR)
  : null;

const videosDir = path.join(__dirname, "public/videos");
fs.mkdirSync(videosDir, { recursive: true });

app.use("/videos", express.static(videosDir));

const MAX_VIDEO_AGE_MS = 2 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;
const FFMPEG_TIMEOUT_MS = Number(
  process.env.FFMPEG_TIMEOUT_MS || 15 * 60 * 1000
);

function getVideoUrl(fileName) {
  return BASE_URL
    ? `${BASE_URL}/videos/${fileName}`
    : `/videos/${fileName}`;
}

function safeDelete(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.error(`Erro ao apagar ${filePath}:`, err.message);
  }
}

function safeRemoveDir(dirPath) {
  try {
    if (dirPath && fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, {
        recursive: true,
        force: true
      });
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
      if (!file.toLowerCase().endsWith(".mp4")) {
        continue;
      }

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

function assertHttpUrl(url, fieldName = "url") {
  let parsed;

  try {
    parsed = new URL(String(url));
  } catch {
    throw new Error(`${fieldName} inválida`);
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${fieldName} precisa usar http ou https`);
  }

  return parsed.toString();
}

async function downloadFile(url, outputPath) {
  const safeUrl = assertHttpUrl(url);

  const response = await fetch(safeUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0"
    },
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(
      `Não consegui baixar: ${safeUrl} | status ${response.status}`
    );
  }

  const arrayBuffer = await response.arrayBuffer();

  fs.writeFileSync(
    outputPath,
    Buffer.from(arrayBuffer)
  );
}

function runProcess(
  binary,
  args,
  timeoutMs = FFMPEG_TIMEOUT_MS
) {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 20 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          return reject(
            new Error(stderr || error.message)
          );
        }

        resolve({
          stdout,
          stderr
        });
      }
    );
  });
}

function runFfmpeg(
  args,
  timeoutMs = FFMPEG_TIMEOUT_MS
) {
  return runProcess(
    "ffmpeg",
    args,
    timeoutMs
  );
}

function buildZoomFilter(duration, zoomEnd) {
  const fps = 30;

  const safeDuration = Math.max(
    0.1,
    Number(duration || 6)
  );

  const safeZoomEnd = Math.max(
    1,
    Number(zoomEnd || 1.08)
  );

  const frames = Math.max(
    1,
    Math.round(safeDuration * fps)
  );

  const framesMinusOne = Math.max(
    frames - 1,
    1
  );

  const zoomDelta = safeZoomEnd - 1;

  return [
    "scale=2160:3840:force_original_aspect_ratio=increase",
    "crop=2160:3840",
    "setsar=1",
    `zoompan=z='1+${zoomDelta}*on/${framesMinusOne}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1080x1920:fps=${fps}`,
    "format=yuv420p"
  ].join(",");
}

async function renderImageScene(
  inputPath,
  outputPath,
  duration,
  zoomEnd
) {
  const safeDuration = Math.max(
    0.1,
    Number(duration || 6)
  );

  const vf = buildZoomFilter(
    safeDuration,
    zoomEnd
  );

  const args = [
    "-y",
    "-loop", "1",
    "-i", inputPath,
    "-t", String(safeDuration),
    "-vf", vf,
    "-r", "30",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    outputPath
  ];

  await runFfmpeg(args);
}

async function renderImageAudioScene(
  imagePath,
  audioPath,
  outputPath,
  duration,
  zoomEnd
) {
  const safeDuration = Math.max(
    0.1,
    Number(duration || 6)
  );

  const vf = buildZoomFilter(
    safeDuration,
    zoomEnd
  );

  const args = [
    "-y",

    "-loop", "1",
    "-i", imagePath,

    "-i", audioPath,

    "-t", String(safeDuration),

    "-vf", vf,
    "-af", "apad",

    "-map", "0:v:0",
    "-map", "1:a:0",

    "-r", "30",

    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",

    "-c:a", "aac",
    "-b:a", "192k",
    "-ar", "48000",
    "-ac", "2",

    "-shortest",
    "-movflags", "+faststart",

    outputPath
  ];

  await runFfmpeg(args);
}

async function normalizeVideoScene(
  inputPath,
  outputPath
) {
  const args = [
    "-y",
    "-i", inputPath,

    "-vf",
    "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,format=yuv420p",

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
  return String(filePath).replace(
    /'/g,
    "'\\''"
  );
}

async function concatVideos(
  scenePaths,
  listPath,
  outputPath,
  includeAudio = false
) {
  if (
    !Array.isArray(scenePaths)
    || scenePaths.length === 0
  ) {
    throw new Error(
      "Nenhuma cena foi gerada para concatenação"
    );
  }

  const listContent = scenePaths
    .map((scenePath) => {
      return `file '${escapeConcatPath(scenePath)}'`;
    })
    .join("\n");

  fs.writeFileSync(
    listPath,
    `${listContent}\n`,
    "utf8"
  );

  const argsCopy = [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,
    "-c", "copy",
    "-movflags", "+faststart",
    outputPath
  ];

  try {
    await runFfmpeg(argsCopy);
    return;
  } catch (err) {
    console.log(
      "Concat com copy falhou. Tentando reencodar vídeo e áudio..."
    );
  }

  const argsReencode = [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,
    "-map", "0:v:0"
  ];

  if (includeAudio) {
    argsReencode.push(
      "-map",
      "0:a:0?"
    );
  }

  argsReencode.push(
    "-vf",
    "scale=1080:1920,setsar=1,format=yuv420p",

    "-r", "30",

    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p"
  );

  if (includeAudio) {
    argsReencode.push(
      "-c:a", "aac",
      "-b:a", "192k",
      "-ar", "48000",
      "-ac", "2"
    );
  } else {
    argsReencode.push("-an");
  }

  argsReencode.push(
    "-movflags", "+faststart",
    outputPath
  );

  await runFfmpeg(argsReencode);
}

function parseTimeToSeconds(timeText) {
  const clean = String(timeText || "")
    .trim()
    .replace(",", ".");

  const parts = clean.split(":");

  if (parts.length !== 3) {
    return 0;
  }

  const hours = Number(parts[0]);
  const minutes = Number(parts[1]);
  const seconds = Number(parts[2]);

  if (
    ![hours, minutes, seconds].every(
      Number.isFinite
    )
  ) {
    return 0;
  }

  return (
    hours * 3600
    + minutes * 60
    + seconds
  );
}

function parseSrtToCaptions(srtText) {
  const blocks = String(srtText || "")
    .replace(/\r/g, "")
    .split(/\n\s*\n/)
    .filter(Boolean);

  const captions = [];

  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const timeLineIndex = lines.findIndex(
      (line) => line.includes("-->")
    );

    if (timeLineIndex === -1) {
      continue;
    }

    const [startText, endText] =
      lines[timeLineIndex]
        .split("-->")
        .map((part) => part.trim());

    const text = lines
      .slice(timeLineIndex + 1)
      .join(" ")
      .trim();

    if (!text) {
      continue;
    }

    const start = parseTimeToSeconds(startText);
    const end = parseTimeToSeconds(endText);

    if (end <= start) {
      continue;
    }

    captions.push({
      start,
      end,
      text
    });
  }

  return captions;
}

function formatAssTime(seconds) {
  const numericSeconds = Number(seconds);

  const totalCentiseconds = Math.max(
    0,
    Math.round(
      (
        Number.isFinite(numericSeconds)
          ? numericSeconds
          : 0
      ) * 100
    )
  );

  const hours = Math.floor(
    totalCentiseconds / 360000
  );

  const minutes = Math.floor(
    (totalCentiseconds % 360000) / 6000
  );

  const secs = Math.floor(
    (totalCentiseconds % 6000) / 100
  );

  const centis =
    totalCentiseconds % 100;

  return (
    `${hours}:`
    + `${String(minutes).padStart(2, "0")}:`
    + `${String(secs).padStart(2, "0")}.`
    + String(centis).padStart(2, "0")
  );
}

function escapeAssText(text) {
  return String(text || "")
    .replace(
      /\\N/gi,
      " __ASS_LINE_BREAK__ "
    )
    .replace(/[{}]/g, "")
    .replace(/\\/g, "")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .replace(
      /__ASS_LINE_BREAK__/g,
      "\\N"
    )
    .trim();
}

function normalizeSpokenWord(text) {
  return escapeAssText(text)
    .replace(/\\N/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function assColorFromHex(
  value,
  fallback = "&H00FFFFFF"
) {
  if (!value) {
    return fallback;
  }

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

function assBackColorFromHex(
  value,
  fallback = "&H88000000",
  alpha = "88"
) {
  if (!value) {
    return fallback;
  }

  const raw = String(value).trim();

  if (/^&H[0-9A-Fa-f]{8}$/.test(raw)) {
    return raw.toUpperCase();
  }

  const rgbaMatch = raw.match(
    /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/i
  );

  if (rgbaMatch) {
    const r = Math.max(
      0,
      Math.min(
        255,
        Number(rgbaMatch[1])
      )
    )
      .toString(16)
      .padStart(2, "0");

    const g = Math.max(
      0,
      Math.min(
        255,
        Number(rgbaMatch[2])
      )
    )
      .toString(16)
      .padStart(2, "0");

    const b = Math.max(
      0,
      Math.min(
        255,
        Number(rgbaMatch[3])
      )
    )
      .toString(16)
      .padStart(2, "0");

    const opacity =
      rgbaMatch[4] === undefined
        ? 0.45
        : Math.max(
          0,
          Math.min(
            1,
            Number(rgbaMatch[4])
          )
        );

    const assAlpha = Math.round(
      (1 - opacity) * 255
    )
      .toString(16)
      .padStart(2, "0");

    return (
      `&H${assAlpha}${b}${g}${r}`
    ).toUpperCase();
  }

  const clean = raw.replace("#", "");

  if (!/^[0-9A-Fa-f]{6}$/.test(clean)) {
    return fallback;
  }

  const rr = clean.slice(0, 2);
  const gg = clean.slice(2, 4);
  const bb = clean.slice(4, 6);

  return (
    `&H${alpha}${bb}${gg}${rr}`
  ).toUpperCase();
}

function assInlineColorFromHex(
  value,
  fallback = "&HFFFFFF&"
) {
  if (!value) {
    return fallback;
  }

  const raw = String(value).trim();

  if (/^&H[0-9A-Fa-f]{6}&$/.test(raw)) {
    return raw.toUpperCase();
  }

  if (/^&H[0-9A-Fa-f]{8}$/.test(raw)) {
    return (
      `&H${raw.slice(4)}&`
    ).toUpperCase();
  }

  const clean = raw.replace("#", "");

  if (!/^[0-9A-Fa-f]{6}$/.test(clean)) {
    return fallback;
  }

  const rr = clean.slice(0, 2);
  const gg = clean.slice(2, 4);
  const bb = clean.slice(4, 6);

  return (
    `&H${bb}${gg}${rr}&`
  ).toUpperCase();
}

function sanitizeFontName(fontName) {
  const clean = String(
    fontName || "DejaVu Sans"
  )
    .replace(/[,\n\r]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return clean || "DejaVu Sans";
}

function clampNumber(
  value,
  fallback,
  min,
  max
) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(
    min,
    Math.min(max, parsed)
  );
}

function wrapCaptionText(
  text,
  maxCharsPerLine = 22,
  maxLines = 2
) {
  const words = escapeAssText(text)
    .replace(/\\N/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const lines = [];
  let current = "";

  for (const word of words) {
    const test = current
      ? `${current} ${word}`
      : word;

    if (
      !current
      || test.length <= maxCharsPerLine
    ) {
      current = test;
    } else {
      lines.push(current);
      current = word;
    }
  }

  if (current) {
    lines.push(current);
  }

  if (lines.length <= maxLines) {
    return lines.join("\\N");
  }

  return lines
    .slice(0, maxLines)
    .join("\\N");
}

function createStandardAssSubtitle(
  captions,
  outputPath,
  options = {}
) {
  const fontSize = clampNumber(
    options.caption_font_size,
    76,
    30,
    160
  );

  const marginV = clampNumber(
    options.caption_margin_v,
    235,
    0,
    900
  );

  const uppercase =
    options.caption_uppercase !== false;

  const maxCharsPerLine = clampNumber(
    options.caption_max_chars_per_line,
    22,
    8,
    60
  );

  const maxLines = clampNumber(
    options.caption_max_lines,
    2,
    1,
    4
  );

  const fontFamily = sanitizeFontName(
    options.caption_font_family
    || "DejaVu Sans"
  );

  const primaryColor = assColorFromHex(
    options.caption_font_color
    || "#FFFFFF",
    "&H00FFFFFF"
  );

  const outlineColor = assColorFromHex(
    options.caption_stroke_color
    || "#090909",
    "&H00090909"
  );

  const shadowColor = assBackColorFromHex(
    options.caption_shadow_color
    || "#000000",
    "&H70000000",
    "70"
  );

  const boxColor = assBackColorFromHex(
    options.caption_box_color
    || "rgba(0,0,0,0.42)",
    "&H93000000"
  );

  const outline = clampNumber(
    options.caption_stroke_width,
    5,
    0,
    20
  );

  const shadow = clampNumber(
    options.caption_shadow_size,
    3,
    0,
    20
  );

  const spacing = clampNumber(
    options.caption_letter_spacing,
    0,
    -5,
    20
  );

  const fadeIn = clampNumber(
    options.caption_fade_in_ms,
    90,
    0,
    1000
  );

  const fadeOut = clampNumber(
    options.caption_fade_out_ms,
    100,
    0,
    1000
  );

  const boxEnabled =
    options.caption_box !== false;

  const header = `[Script Info]
Title: Legenda padrão
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Text,${fontFamily},${fontSize},${primaryColor},${primaryColor},${outlineColor},${shadowColor},-1,0,0,0,100,100,${spacing},0,1,${outline},${shadow},2,78,78,${marginV},1
Style: Box,${fontFamily},${fontSize},&HFF000000,&HFF000000,&HFF000000,${boxColor},-1,0,0,0,100,100,${spacing},0,3,18,0,2,78,78,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  const events = captions
    .filter((caption) => {
      return (
        Number(caption.end)
        > Number(caption.start)
      );
    })
    .flatMap((caption) => {
      const start = formatAssTime(
        caption.start
      );

      const end = formatAssTime(
        caption.end
      );

      let text = String(
        caption.text || ""
      );

      if (uppercase) {
        text = text.toUpperCase();
      }

      const wrapped = wrapCaptionText(
        text,
        maxCharsPerLine,
        maxLines
      );

      if (!wrapped) {
        return [];
      }

      const fadeTag =
        `{\\fad(${fadeIn},${fadeOut})}`;

      const lines = [];

      if (boxEnabled) {
        lines.push(
          `Dialogue: 0,${start},${end},Box,,0,0,0,,${fadeTag}${wrapped}`
        );
      }

      lines.push(
        `Dialogue: 1,${start},${end},Text,,0,0,0,,${fadeTag}${wrapped}`
      );

      return lines;
    })
    .join("\n");

  fs.writeFileSync(
    outputPath,
    `${header}\n${events}\n`,
    "utf8"
  );
}

function findWordArray(body) {
  const candidates = [
    body.subtitle_words,
    body.word_timestamps,
    body.words,
    body.transcription
      && body.transcription.words,
    body.openai_transcription
      && body.openai_transcription.words
  ];

  return (
    candidates.find(Array.isArray)
    || []
  );
}

function normalizeWordTimings(body) {
  const rawWords = findWordArray(body);

  const words = rawWords
    .map((entry, originalIndex) => {
      const text = normalizeSpokenWord(
        entry
        && typeof entry === "object"
          ? (
            entry.word
            ?? entry.text
            ?? entry.token
            ?? ""
          )
          : entry
      );

      const start = Number(
        entry
        && typeof entry === "object"
          ? (
            entry.start
            ?? entry.start_time
            ?? entry.startTime
          )
          : NaN
      );

      const end = Number(
        entry
        && typeof entry === "object"
          ? (
            entry.end
            ?? entry.end_time
            ?? entry.endTime
          )
          : NaN
      );

      return {
        text,
        start,
        end,
        originalIndex
      };
    })
    .filter((word) => {
      return (
        word.text
        && Number.isFinite(word.start)
        && Number.isFinite(word.end)
        && word.end > word.start
        && word.start >= 0
      );
    })
    .sort((a, b) => {
      if (a.start !== b.start) {
        return a.start - b.start;
      }

      return (
        a.originalIndex
        - b.originalIndex
      );
    });

  return words;
}

function layoutWordLines(
  words,
  maxCharsPerLine
) {
  const lines = [];

  let currentLine = [];
  let currentLength = 0;

  for (const word of words) {
    const additionalLength =
      currentLine.length === 0
        ? word.text.length
        : word.text.length + 1;

    if (
      currentLine.length > 0
      && currentLength
        + additionalLength
        > maxCharsPerLine
    ) {
      lines.push(currentLine);

      currentLine = [word];
      currentLength = word.text.length;
    } else {
      currentLine.push(word);
      currentLength += additionalLength;
    }
  }

  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return lines;
}

function shouldEndBlockAfterWord(
  word,
  blockSize,
  options
) {
  if (
    options.breakOnPunctuation
    === false
  ) {
    return false;
  }

  if (
    blockSize
    < options.minWordsBeforePunctuationBreak
  ) {
    return false;
  }

  return /[.!?…]$/.test(word.text);
}

function groupWordsIntoCaptionBlocks(
  words,
  options
) {
  const blocks = [];
  let current = [];

  function pushCurrent() {
    if (current.length === 0) {
      return;
    }

    blocks.push({
      words: current,
      lines: layoutWordLines(
        current,
        options.maxCharsPerLine
      ),
      start: current[0].start,
      end: current[current.length - 1].end
    });

    current = [];
  }

  for (const word of words) {
    if (current.length === 0) {
      current.push(word);
      continue;
    }

    const previous =
      current[current.length - 1];

    const gap = Math.max(
      0,
      word.start - previous.end
    );

    const proposed = [
      ...current,
      word
    ];

    const proposedLines =
      layoutWordLines(
        proposed,
        options.maxCharsPerLine
      );

    const proposedDuration =
      word.end - current[0].start;

    const mustSplit =
      current.length
        >= options.maxWordsPerBlock

      || proposedLines.length
        > options.maxLines

      || proposedDuration
        > options.maxBlockDuration

      || gap
        > options.gapSplitSeconds

      || shouldEndBlockAfterWord(
        previous,
        current.length,
        options
      );

    if (mustSplit) {
      pushCurrent();
    }

    current.push(word);
  }

  pushCurrent();

  return blocks;
}

function buildAssBlockText(
  block,
  activeWordIndex,
  colors
) {
  let globalIndex = 0;

  return block.lines
    .map((line) => {
      const lineText = line
        .map((word) => {
          const currentIndex =
            globalIndex;

          globalIndex += 1;

          if (
            currentIndex
            !== activeWordIndex
          ) {
            return word.text;
          }

          return (
            `{\\c${colors.highlight}}`
            + word.text
            + `{\\c${colors.primaryInline}}`
          );
        })
        .join(" ");

      return lineText;
    })
    .join("\\N");
}

function createWordKaraokeAss(
  words,
  outputPath,
  options = {}
) {
  if (
    !Array.isArray(words)
    || words.length === 0
  ) {
    throw new Error(
      "Nenhuma palavra válida foi recebida para gerar a legenda karaokê"
    );
  }

  const fontSize = clampNumber(
    options.caption_font_size,
    76,
    30,
    160
  );

  const marginV = clampNumber(
    options.caption_margin_v,
    235,
    0,
    900
  );

  const uppercase =
    options.caption_uppercase !== false;

  const fontFamily = sanitizeFontName(
    options.caption_font_family
    || "DejaVu Sans"
  );

  const maxCharsPerLine = clampNumber(
    options.caption_max_chars_per_line,
    22,
    8,
    60
  );

  const maxLines = clampNumber(
    options.caption_max_lines,
    2,
    1,
    3
  );

  const maxWordsPerBlock = clampNumber(
    options.caption_max_words_per_block,
    7,
    2,
    14
  );

  const maxBlockDuration = clampNumber(
    options.caption_max_block_duration,
    4.2,
    0.8,
    10
  );

  const gapSplitSeconds = clampNumber(
    options.caption_gap_split_seconds,
    0.7,
    0.1,
    3
  );

  const minWordsBeforePunctuationBreak =
    clampNumber(
      options.caption_min_words_before_punctuation_break,
      3,
      1,
      10
    );

  const primaryColor = assColorFromHex(
    options.caption_font_color
    || "#FFFFFF",
    "&H00FFFFFF"
  );

  const primaryInline =
    assInlineColorFromHex(
      options.caption_font_color
      || "#FFFFFF",
      "&HFFFFFF&"
    );

  const highlightColor =
    assInlineColorFromHex(
      options.caption_highlight_color
      || "#FFD400",
      "&H00D4FF&"
    );

  const outlineColor = assColorFromHex(
    options.caption_stroke_color
    || "#090909",
    "&H00090909"
  );

  const shadowColor =
    assBackColorFromHex(
      options.caption_shadow_color
      || "rgba(0,0,0,0.65)",
      "&H59000000"
    );

  const boxColor =
    assBackColorFromHex(
      options.caption_box_color
      || "rgba(0,0,0,0.38)",
      "&H9E000000"
    );

  const outline = clampNumber(
    options.caption_stroke_width,
    5,
    0,
    20
  );

  const shadow = clampNumber(
    options.caption_shadow_size,
    3,
    0,
    20
  );

  const spacing = clampNumber(
    options.caption_letter_spacing,
    0,
    -5,
    20
  );

  const fadeIn = clampNumber(
    options.caption_fade_in_ms,
    60,
    0,
    1000
  );

  const fadeOut = clampNumber(
    options.caption_fade_out_ms,
    70,
    0,
    1000
  );

  const highlightLeadSeconds =
    clampNumber(
      Number(
        options.caption_highlight_lead_ms
        || 0
      ) / 1000,
      0,
      0,
      0.25
    );

  const highlightTailSeconds =
    clampNumber(
      Number(
        options.caption_highlight_tail_ms
        || 0
      ) / 1000,
      0,
      0,
      0.25
    );

  const boxEnabled =
    options.caption_box !== false;

  const preparedWords = words.map(
    (word) => ({
      ...word,
      text: uppercase
        ? word.text.toUpperCase()
        : word.text
    })
  );

  const blocks =
    groupWordsIntoCaptionBlocks(
      preparedWords,
      {
        maxCharsPerLine,
        maxLines,
        maxWordsPerBlock,
        maxBlockDuration,
        gapSplitSeconds,
        breakOnPunctuation:
          options.caption_break_on_punctuation
          !== false,
        minWordsBeforePunctuationBreak
      }
    );

  const header = `[Script Info]
Title: Legenda karaokê por palavra
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes
WrapStyle: 2
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: KaraokeText,${fontFamily},${fontSize},${primaryColor},${primaryColor},${outlineColor},${shadowColor},-1,0,0,0,100,100,${spacing},0,1,${outline},${shadow},2,78,78,${marginV},1
Style: KaraokeBox,${fontFamily},${fontSize},&HFF000000,&HFF000000,&HFF000000,${boxColor},-1,0,0,0,100,100,${spacing},0,3,18,0,2,78,78,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  const events = [];

  for (const block of blocks) {
    const blockStart =
      formatAssTime(block.start);

    const blockEnd =
      formatAssTime(block.end);

    const baseText =
      buildAssBlockText(
        block,
        -1,
        {
          highlight: highlightColor,
          primaryInline
        }
      );

    const fadeTag =
      `{\\fad(${fadeIn},${fadeOut})}`;

    if (boxEnabled) {
      events.push(
        `Dialogue: 0,${blockStart},${blockEnd},KaraokeBox,,0,0,0,,${fadeTag}${baseText}`
      );
    }

    events.push(
      `Dialogue: 1,${blockStart},${blockEnd},KaraokeText,,0,0,0,,${fadeTag}${baseText}`
    );

    for (
      let i = 0;
      i < block.words.length;
      i++
    ) {
      const word = block.words[i];

      const start = Math.max(
        block.start,
        word.start
          - highlightLeadSeconds
      );

      const end = Math.min(
        block.end,
        word.end
          + highlightTailSeconds
      );

      if (end <= start) {
        continue;
      }

      const highlightedText =
        buildAssBlockText(
          block,
          i,
          {
            highlight: highlightColor,
            primaryInline
          }
        );

      events.push(
        `Dialogue: 2,${formatAssTime(start)},${formatAssTime(end)},KaraokeText,,0,0,0,,${highlightedText}`
      );
    }
  }

  fs.writeFileSync(
    outputPath,
    `${header}\n${events.join("\n")}\n`,
    "utf8"
  );
}

function validateAssContent(content) {
  const text = String(content || "")
    .replace(/^\uFEFF/, "")
    .trim();

  if (!text) {
    throw new Error(
      "subtitle_ass está vazio"
    );
  }

  if (
    !/\[Script Info\]/i.test(text)
    || !/\[Events\]/i.test(text)
  ) {
    throw new Error(
      "subtitle_ass não parece ser um arquivo ASS válido"
    );
  }

  return text;
}

function decodeAssBase64(base64Text) {
  const raw = String(base64Text || "")
    .replace(
      /^data:[^;]+;base64,/i,
      ""
    )
    .replace(/\s+/g, "");

  if (!raw) {
    throw new Error(
      "subtitle_ass_base64 está vazio"
    );
  }

  return Buffer
    .from(raw, "base64")
    .toString("utf8");
}

function hasExplicitSubtitlePayload(body) {
  return Boolean(
    body.subtitle_ass
    || body.subtitle_ass_base64
    || body.subtitle_ass_url
    || body.subtitle_srt
    || Array.isArray(body.captions)
    || findWordArray(body).length > 0
  );
}

async function buildSubtitle(
  jobDir,
  body
) {
  const assPath = path.join(
    jobDir,
    "legenda.ass"
  );

  if (body.subtitle_ass) {
    const content = validateAssContent(
      body.subtitle_ass
    );

    fs.writeFileSync(
      assPath,
      `${content}\n`,
      "utf8"
    );

    return {
      path: assPath,
      mode: "provided_ass"
    };
  }

  if (body.subtitle_ass_base64) {
    const decoded =
      decodeAssBase64(
        body.subtitle_ass_base64
      );

    const content =
      validateAssContent(decoded);

    fs.writeFileSync(
      assPath,
      `${content}\n`,
      "utf8"
    );

    return {
      path: assPath,
      mode: "provided_ass_base64"
    };
  }

  if (body.subtitle_ass_url) {
    const downloadedAssPath =
      path.join(
        jobDir,
        "legenda-download.ass"
      );

    await downloadFile(
      body.subtitle_ass_url,
      downloadedAssPath
    );

    const content =
      validateAssContent(
        fs.readFileSync(
          downloadedAssPath,
          "utf8"
        )
      );

    fs.writeFileSync(
      assPath,
      `${content}\n`,
      "utf8"
    );

    return {
      path: assPath,
      mode: "provided_ass_url"
    };
  }

  const wordTimings =
    normalizeWordTimings(body);

  if (wordTimings.length > 0) {
    createWordKaraokeAss(
      wordTimings,
      assPath,
      body
    );

    return {
      path: assPath,
      mode: "word_karaoke_ass",
      words_count: wordTimings.length
    };
  }

  let captions = [];

  if (Array.isArray(body.captions)) {
    captions = body.captions;
  } else if (body.subtitle_srt) {
    captions = parseSrtToCaptions(
      body.subtitle_srt
    );
  }

  if (
    !Array.isArray(captions)
    || captions.length === 0
  ) {
    return {
      path: null,
      mode: "none"
    };
  }

  createStandardAssSubtitle(
    captions,
    assPath,
    body
  );

  return {
    path: assPath,
    mode: "standard_ass",
    captions_count: captions.length
  };
}

function escapeFfmpegFilterValue(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

function buildSubtitleFilter(subtitlePath) {
  const escapedSubtitlePath =
    escapeFfmpegFilterValue(
      subtitlePath
    );

  let filter =
    `ass=filename='${escapedSubtitlePath}'`;

  if (
    FONTS_DIR
    && fs.existsSync(FONTS_DIR)
  ) {
    filter +=
      `:fontsdir='${escapeFfmpegFilterValue(FONTS_DIR)}'`;
  }

  return filter;
}

async function muxFinalVideo({
  videoPath,
  outputPath,
  audioPath,
  musicPath,
  subtitlePath,
  musicVolume,
  useVideoAudio = false
}) {
  const hasExternalAudio =
    Boolean(audioPath);

  const hasVideoAudio =
    Boolean(useVideoAudio);

  const hasBaseAudio =
    hasExternalAudio
    || hasVideoAudio;

  const hasMusic =
    Boolean(musicPath);

  const hasSubtitle =
    Boolean(subtitlePath);

  const safeMusicVolume =
    clampNumber(
      musicVolume,
      0.07,
      0,
      2
    );

  const args = [
    "-y",
    "-i",
    videoPath
  ];

  let externalAudioIndex = null;
  let musicIndex = null;
  let inputIndex = 1;

  if (hasExternalAudio) {
    args.push(
      "-i",
      audioPath
    );

    externalAudioIndex =
      inputIndex;

    inputIndex += 1;
  }

  if (hasMusic) {
    args.push(
      "-stream_loop",
      "-1",
      "-i",
      musicPath
    );

    musicIndex =
      inputIndex;

    inputIndex += 1;
  }

  const filterParts = [];

  if (hasSubtitle) {
    filterParts.push(
      `[0:v]${buildSubtitleFilter(subtitlePath)}[vout]`
    );
  }

  if (
    hasBaseAudio
    && hasMusic
  ) {
    const baseAudioLabel =
      hasExternalAudio
        ? `[${externalAudioIndex}:a:0]`
        : "[0:a:0]";

    filterParts.push(
      `[${musicIndex}:a:0]volume=${safeMusicVolume},aresample=48000[music]`
    );

    filterParts.push(
      `${baseAudioLabel}aresample=48000[voice]`
    );

    filterParts.push(
      "[voice][music]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[aout]"
    );
  } else if (
    !hasBaseAudio
    && hasMusic
  ) {
    filterParts.push(
      `[${musicIndex}:a:0]volume=${safeMusicVolume},aresample=48000[aout]`
    );
  }

  if (filterParts.length > 0) {
    args.push(
      "-filter_complex",
      filterParts.join(";")
    );
  }

  if (hasSubtitle) {
    args.push(
      "-map",
      "[vout]"
    );
  } else {
    args.push(
      "-map",
      "0:v:0"
    );
  }

  if (
    hasBaseAudio
    && hasMusic
  ) {
    args.push(
      "-map",
      "[aout]"
    );
  } else if (
    hasExternalAudio
    && !hasMusic
  ) {
    args.push(
      "-map",
      `${externalAudioIndex}:a:0`
    );
  } else if (
    hasVideoAudio
    && !hasMusic
  ) {
    args.push(
      "-map",
      "0:a:0"
    );
  } else if (
    !hasBaseAudio
    && hasMusic
  ) {
    args.push(
      "-map",
      "[aout]"
    );
  } else {
    args.push("-an");
  }

  args.push(
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-r", "30"
  );

  if (
    hasBaseAudio
    || hasMusic
  ) {
    args.push(
      "-c:a", "aac",
      "-b:a", "192k",
      "-ar", "48000",
      "-ac", "2",
      "-shortest"
    );
  }

  args.push(
    "-movflags",
    "+faststart",
    outputPath
  );

  await runFfmpeg(args);
}

function hasPerSceneAudio(body) {
  return (
    Array.isArray(body.scenes)
    && body.scenes.some((scene) => {
      return (
        scene
        && typeof scene === "object"
        && scene.image_url
        && scene.audio_url
      );
    })
  );
}

function normalizeImageScenes(body) {
  if (Array.isArray(body.scenes)) {
    const sceneObjects =
      body.scenes.filter((scene) => {
        return (
          scene
          && typeof scene === "object"
          && scene.image_url
        );
      });

    if (sceneObjects.length > 0) {
      return sceneObjects;
    }
  }

  if (Array.isArray(body.images)) {
    return body.images.map((image) => {
      if (typeof image === "string") {
        return {
          image_url: image
        };
      }

      return image;
    });
  }

  return [];
}

function normalizeVideoSceneUrls(body) {
  if (Array.isArray(body.scene_urls)) {
    return body.scene_urls.filter(Boolean);
  }

  if (Array.isArray(body.scenes)) {
    return body.scenes.filter((scene) => {
      return (
        typeof scene === "string"
        && scene
      );
    });
  }

  return [];
}

function buildCaptionsFromScenes(scenes) {
  let current = 0;
  const captions = [];

  for (const scene of scenes) {
    const duration = Number(
      scene.duration
      || scene.duracao_segundos
      || 6
    );

    const text = String(
      scene.caption
      || scene.text
      || scene.legenda
      || scene.narracao
      || ""
    )
      .replace(/\s+/g, " ")
      .trim();

    if (
      text
      && duration > 0
    ) {
      captions.push({
        start: Number(
          current.toFixed(3)
        ),
        end: Number(
          (
            current + duration
          ).toFixed(3)
        ),
        text
      });
    }

    current +=
      duration > 0
        ? duration
        : 0;
  }

  return captions;
}

app.get("/", (req, res) => {
  res.json({
    ok: true,

    message:
      "API FFmpeg online",

    routes: {
      image:
        "POST /render/image",

      final:
        "POST /render/final"
    },

    subtitles: {
      karaoke:
        "Envie subtitle_words, word_timestamps, words ou transcription.words",

      ready_ass:
        "Envie subtitle_ass, subtitle_ass_base64 ou subtitle_ass_url",

      fallback:
        "Envie captions, scenes[].caption ou subtitle_srt"
    },

    karaoke_behavior:
      "Somente a palavra falada fica amarela; as demais permanecem brancas",

    fonts_dir:
      FONTS_DIR
      || "não configurado"
  });
});

app.post(
  "/render/image",
  async (req, res) => {
    const id = crypto
      .randomBytes(8)
      .toString("hex");

    const inputPath = path.join(
      "/tmp",
      `${id}.input`
    );

    const outputFileName =
      `${id}.mp4`;

    const outputPath = path.join(
      videosDir,
      outputFileName
    );

    try {
      const imageUrl =
        req.body.image_url;

      const duration = Number(
        req.body.duration || 6
      );

      const zoomEnd = Number(
        req.body.zoom_end || 1.08
      );

      if (!imageUrl) {
        return res
          .status(400)
          .json({
            ok: false,
            error: "Envie image_url"
          });
      }

      if (
        !Number.isFinite(duration)
        || duration <= 0
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "duration precisa ser maior que 0"
          });
      }

      if (
        !Number.isFinite(zoomEnd)
        || zoomEnd < 1
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "zoom_end precisa ser maior ou igual a 1"
          });
      }

      await downloadFile(
        imageUrl,
        inputPath
      );

      await renderImageScene(
        inputPath,
        outputPath,
        duration,
        zoomEnd
      );

      return res.json({
        ok: true,

        video_url:
          getVideoUrl(outputFileName),

        expires_in_hours: 2
      });
    } catch (err) {
      console.error(
        "Erro /render/image:",
        err.message
      );

      safeDelete(outputPath);

      return res
        .status(500)
        .json({
          ok: false,

          error:
            "Erro ao gerar vídeo da imagem",

          details:
            err.message
        });
    } finally {
      safeDelete(inputPath);
    }
  }
);

app.post(
  "/render/final",
  async (req, res) => {
    const jobId = crypto
      .randomBytes(8)
      .toString("hex");

    const jobDir = path.join(
      "/tmp",
      `job-${jobId}`
    );

    fs.mkdirSync(
      jobDir,
      {
        recursive: true
      }
    );

    const outputFileName =
      `${jobId}-final.mp4`;

    const outputPath = path.join(
      videosDir,
      outputFileName
    );

    try {
      const imageScenes =
        normalizeImageScenes(req.body);

      const videoSceneUrls =
        normalizeVideoSceneUrls(req.body);

      const perSceneAudioMode =
        hasPerSceneAudio(req.body);

      const audioUrl =
        perSceneAudioMode
          ? null
          : (
            req.body.audio_url
            || null
          );

      const musicUrl =
        req.body.music_url
        || null;

      const musicVolume = Number(
        req.body.music_volume
        ?? 0.07
      );

      if (
        imageScenes.length === 0
        && videoSceneUrls.length === 0
      ) {
        return res
          .status(400)
          .json({
            ok: false,

            error:
              "Envie images, scenes ou scene_urls"
          });
      }

      if (perSceneAudioMode) {
        const invalidSceneIndex =
          imageScenes.findIndex(
            (scene) => !scene.audio_url
          );

        if (invalidSceneIndex !== -1) {
          return res
            .status(400)
            .json({
              ok: false,

              error:
                `Modo por cena ativado, mas a cena ${invalidSceneIndex + 1} está sem audio_url`
            });
        }
      }

      const scenePaths = [];

      for (
        let i = 0;
        i < imageScenes.length;
        i++
      ) {
        const scene =
          imageScenes[i];

        const imageUrl =
          scene.image_url;

        const audioSegmentUrl =
          scene.audio_url || null;

        const duration = Number(
          scene.duration
          || scene.duracao_segundos
          || req.body.default_scene_duration
          || 6
        );

        const zoomEnd = Number(
          scene.zoom_end
          || req.body.default_zoom_end
          || 1.08
        );

        if (!imageUrl) {
          throw new Error(
            `Cena ${i + 1} está sem image_url`
          );
        }

        if (
          !Number.isFinite(duration)
          || duration <= 0
        ) {
          throw new Error(
            `Cena ${i + 1} está com duration inválida`
          );
        }

        if (
          !Number.isFinite(zoomEnd)
          || zoomEnd < 1
        ) {
          throw new Error(
            `Cena ${i + 1} está com zoom_end inválido`
          );
        }

        const inputImagePath =
          path.join(
            jobDir,
            `image-${i + 1}.input`
          );

        const inputAudioPath =
          path.join(
            jobDir,
            `audio-${i + 1}.input`
          );

        const sceneVideoPath =
          path.join(
            jobDir,
            `scene-${i + 1}.mp4`
          );

        await downloadFile(
          imageUrl,
          inputImagePath
        );

        if (perSceneAudioMode) {
          await downloadFile(
            audioSegmentUrl,
            inputAudioPath
          );

          await renderImageAudioScene(
            inputImagePath,
            inputAudioPath,
            sceneVideoPath,
            duration,
            zoomEnd
          );
        } else {
          await renderImageScene(
            inputImagePath,
            sceneVideoPath,
            duration,
            zoomEnd
          );
        }

        scenePaths.push(
          sceneVideoPath
        );
      }

      for (
        let i = 0;
        i < videoSceneUrls.length;
        i++
      ) {
        const sceneUrl =
          videoSceneUrls[i];

        const inputVideoPath =
          path.join(
            jobDir,
            `input-video-${i + 1}.mp4`
          );

        const normalizedVideoPath =
          path.join(
            jobDir,
            `normalized-video-${i + 1}.mp4`
          );

        await downloadFile(
          sceneUrl,
          inputVideoPath
        );

        await normalizeVideoScene(
          inputVideoPath,
          normalizedVideoPath
        );

        scenePaths.push(
          normalizedVideoPath
        );
      }

      const listPath = path.join(
        jobDir,
        "scenes.txt"
      );

      const concatPath = path.join(
        jobDir,
        "concat.mp4"
      );

      await concatVideos(
        scenePaths,
        listPath,
        concatPath,
        perSceneAudioMode
      );

      let audioPath = null;
      let musicPath = null;

      if (audioUrl) {
        audioPath = path.join(
          jobDir,
          "narracao.audio"
        );

        await downloadFile(
          audioUrl,
          audioPath
        );
      }

      if (musicUrl) {
        musicPath = path.join(
          jobDir,
          "musica.audio"
        );

        await downloadFile(
          musicUrl,
          musicPath
        );
      }

      const bodyForSubtitles = {
        ...req.body
      };

      if (
        perSceneAudioMode
        && !hasExplicitSubtitlePayload(
          bodyForSubtitles
        )
      ) {
        bodyForSubtitles.captions =
          buildCaptionsFromScenes(
            imageScenes
          );
      }

      const subtitle =
        await buildSubtitle(
          jobDir,
          bodyForSubtitles
        );

      await muxFinalVideo({
        videoPath: concatPath,
        outputPath,
        audioPath,
        musicPath,

        subtitlePath:
          subtitle.path,

        musicVolume,

        useVideoAudio:
          perSceneAudioMode
      });

      return res.json({
        ok: true,

        video_url:
          getVideoUrl(outputFileName),

        scenes_count:
          scenePaths.length,

        audio_mode:
          perSceneAudioMode
            ? "per_scene_audio"
            : (
              audioPath
                ? "single_audio_fallback"
                : "no_voice_audio"
            ),

        subtitles:
          subtitle.mode,

        words_count:
          subtitle.words_count || 0,

        captions_count:
          subtitle.captions_count || 0,

        expires_in_hours: 2
      });
    } catch (err) {
      console.error(
        "Erro /render/final:",
        err.message
      );

      safeDelete(outputPath);

      return res
        .status(500)
        .json({
          ok: false,

          error:
            "Erro ao gerar vídeo final",

          details:
            err.message
        });
    } finally {
      safeRemoveDir(jobDir);
    }
  }
);

cleanupOldVideos();

setInterval(
  cleanupOldVideos,
  CLEANUP_INTERVAL_MS
).unref();

app.listen(PORT, () => {
  console.log(
    `API FFmpeg rodando na porta ${PORT}`
  );

  console.log(
    "POST /render/image"
  );

  console.log(
    "POST /render/final"
  );

  console.log(
    "Legenda karaokê: subtitle_words, word_timestamps, words ou transcription.words."
  );

  console.log(
    "Arquivo ASS pronto: subtitle_ass, subtitle_ass_base64 ou subtitle_ass_url."
  );

  console.log(
    "Fallback antigo: captions, scenes[].caption ou subtitle_srt."
  );

  console.log(
    "Áudio por cena: scenes[].audio_url."
  );

  console.log(
    `FONTS_DIR: ${FONTS_DIR || "não configurado"}`
  );

  console.log(
    "Limpeza automática: vídeos com mais de 2 horas serão apagados."
  );
});
