import express from "express";
import multer from "multer";
import cors from "cors";
import dotenv from "dotenv";
import { OpenAI } from "openai";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer({ dest: "uploads/" });
const PORT = 8000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cors());
app.use(express.json());

// Supported language codes mapped to display names
const LANGUAGES = {
  "en-US": "English",
  "fr-FR": "French",
  "tr-TR": "Turkish",
  "es-ES": "Spanish",
  "pl-PL": "Polish",
  "it-IT": "Italian",
  "pt-PT": "Portuguese",
  "cmn-CN": "Chinese",
  "ar-XA": "Arabic",
  "de-DE": "German",
};

// Map voices by language code for TTS
function getVoiceForLang(lang) {
  const femaleVoices = {
    "en-US": "nova",
    "fr-FR": "onyx",
    "es-ES": "shimmer",
    "de-DE": "echo",
  };
  return femaleVoices[lang] || "nova"; // fallback to English voice
}

// Queues to hold translated audio for each user
const streamQueues = {
  A: [], // Audio/messages for user A to receive (sent by B)
  B: [], // Audio/messages for user B to receive (sent by A)
};

app.post("/interpret", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ error: "No audio file uploaded." });

    const audioPath = req.file.path;
    const { sourceLang, targetLang, mode } = req.body;

    if (!sourceLang || !targetLang) {
      fs.unlinkSync(audioPath);
      return res
        .status(400)
        .json({ error: "Missing sourceLang or targetLang." });
    }

    // Validate mode
    if (!["A", "B"].includes(mode)) {
      fs.unlinkSync(audioPath);
      return res.status(400).json({ error: "Invalid mode value." });
    }

    // Rename file to .webm (Whisper requires correct extension)
    const webmFilePath = `${audioPath}.webm`;
    fs.renameSync(audioPath, webmFilePath);

    // Transcribe audio with Whisper
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(webmFilePath),
      model: "whisper-1",
      language: sourceLang.split("-")[0], // use first part of lang code for Whisper
    });

    const transcript = transcription.text;
    console.log("🗣 Transcript:", transcript);

    // Translate transcript text to the target language
    const translationPrompt = `Translate this text to ${LANGUAGES[targetLang]}:\n${transcript}`;

    const translationResult = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "user", content: translationPrompt }],
    });

    const interpretedText = translationResult.choices[0].message.content;
    console.log("🌐 Translated:", interpretedText);

    // Generate speech audio with TTS in target language
    const mp3Response = await openai.audio.speech.create({
      model: "tts-1",
      voice: getVoiceForLang(targetLang),
      input: interpretedText,
    });

    const audioBuffer = Buffer.from(await mp3Response.arrayBuffer());
    const base64Audio = audioBuffer.toString("base64");

    // Prepare payload to send to the opposite user
    const streamPayload = {
      audioBase64: base64Audio,
      text: interpretedText,
      timestamp: Date.now(),
    };

    // Add to the *other* user's queue
    if (mode === "A") {
      streamQueues.B.push(streamPayload); // A sends => B receives
    } else if (mode === "B") {
      streamQueues.A.push(streamPayload); // B sends => A receives
    }

    // Clean up temporary audio file
    fs.unlinkSync(webmFilePath);

    res.json({
      transcript,
      interpretedText,
      audioBase64: base64Audio,
    });
  } catch (error) {
    console.error("Interpretation error:", error);
    res.status(500).json({ error: "Failed to interpret." });
  }
});

// Endpoint for users to poll for new translated audio/messages
app.get("/stream/:mode", (req, res) => {
  const { mode } = req.params;

  if (!["A", "B"].includes(mode)) {
    return res.status(400).json({ error: "Invalid stream mode." });
  }

  const queue = streamQueues[mode];

  if (queue.length === 0) {
    return res.json({ audioBase64: null, text: null, timestamp: null });
  }

  // Return the oldest queued item (FIFO)
  const audioItem = queue.shift();
  res.json(audioItem);
});
app.get("/", (_req, res) => {
  res.send("Hello from the backend!");
});
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
