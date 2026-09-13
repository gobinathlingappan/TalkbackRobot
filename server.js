const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const multer = require('multer');
const { Pool } = require('pg');
const cors = require('cors');
const googleTTS = require('google-tts-api');
const { translate } = require('google-translate-api-x');
const ffmpegPath = require('ffmpeg-static');
const sdk = require('microsoft-cognitiveservices-speech-sdk');

require('dotenv').config();
const envCandidates = ['./talkback.env', './TalkBack.env', './.env'];
for (const candidate of envCandidates) {
  try {
    require('dotenv').config({ path: candidate });
    break;
  } catch (err) {
    // ignore missing file and continue
  }
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function isPlaceholderValue(value) {
  if (value === undefined || value === null) return true;
  const normalized = String(value).trim().toLowerCase();
  return normalized === '' || normalized.includes('your_') || normalized.includes('replace') || normalized.includes('example') || normalized.includes('changeme') || normalized.includes('your-key') || normalized.includes('your_region');
}

function hasAzureSpeechConfig() {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  return !isPlaceholderValue(key) && !isPlaceholderValue(region);
}

function getAzureSpeechConfig() {
  if (!hasAzureSpeechConfig()) {
    return null;
  }

  const config = sdk.SpeechConfig.fromSubscription(
    process.env.AZURE_SPEECH_KEY,
    process.env.AZURE_SPEECH_REGION
  );

  config.setProperty(sdk.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs, '5000');
  config.setProperty(sdk.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs, '1500');
  return config;
}

function getAzureVoiceName(lang, accent = 'us') {
  const voices = {
    en: { us: 'en-US-JennyNeural', uk: 'en-GB-SoniaNeural', au: 'en-AU-NatashaNeural', in: 'en-IN-NeerjaNeural', ca: 'en-CA-ClaireNeural' },
    es: 'es-ES-ElviraNeural',
    fr: 'fr-FR-DeniseNeural',
    de: 'de-DE-KatjaNeural',
    ja: 'ja-JP-NanamiNeural',
    hi: 'hi-IN-SwaraNeural',
    ta: 'ta-IN-PallaviNeural',
    ml: 'ml-IN-SobhanaNeural',
  };

  if (typeof voices[lang] === 'object') {
    return voices[lang][accent] || voices[lang].us;
  }

  return voices[lang] || 'en-US-JennyNeural';
}

async function translateTextToLanguage(text, lang) {
  const translation = await translate(text, { to: lang });
  return translation.text;
}

async function getGoogleAudioUrl(text, lang, accent) {
  const TTS_HOSTS = {
    us: 'https://translate.google.com',
    uk: 'https://translate.google.co.uk',
    au: 'https://translate.google.com.au',
    in: 'https://translate.google.co.in',
    ca: 'https://translate.google.ca',
  };
  const host = TTS_HOSTS[accent] || TTS_HOSTS.us;

  const parts = await googleTTS.getAllAudioBase64(text, {
    lang,
    slow: false,
    host,
  });

  const merged = Buffer.concat(parts.map((p) => Buffer.from(p.base64, 'base64')));
  return `data:audio/mpeg;base64,${merged.toString('base64')}`;
}

async function getAzureAudioUrl(text, lang, accent) {
  const speechConfig = getAzureSpeechConfig();
  if (!speechConfig) {
    return null;
  }

  speechConfig.speechSynthesisVoiceName = getAzureVoiceName(lang, accent);

  return new Promise((resolve, reject) => {
    const synthesizer = new sdk.SpeechSynthesizer(speechConfig, null);

    synthesizer.speakTextAsync(
      text,
      (result) => {
        synthesizer.close();
        if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
          resolve(`data:audio/wav;base64,${Buffer.from(result.audioData).toString('base64')}`);
          return;
        }

        reject(new Error(result.errorDetails || 'Azure TTS failed.'));
      },
      (error) => {
        synthesizer.close();
        reject(error);
      }
    );
  });
}

function convertAudioToWav(inputPath, mimeType = '') {
  const ext = path.extname(inputPath).toLowerCase();

  if (mimeType.includes('wav') || ext === '.wav') {
    return inputPath;
  }

  if (!ffmpegPath) {
    throw new Error('ffmpeg is not installed. Please upload a WAV file or ensure ffmpeg is available.');
  }

  const outputPath = `${inputPath}.wav`;
  execFileSync(ffmpegPath, ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outputPath], {
    stdio: 'ignore',
  });

  return outputPath;
}

async function transcribeAudioFile(filePath, language = 'en-US') {
  const speechConfig = getAzureSpeechConfig();
  if (!speechConfig) {
    throw new Error('Azure Speech transcription is unavailable because AZURE_SPEECH_KEY and AZURE_SPEECH_REGION are missing. Use the browser voice input flow or add valid Azure Speech credentials.');
  }

  speechConfig.speechRecognitionLanguage = language;

  return new Promise((resolve, reject) => {
    const audioConfig = sdk.AudioConfig.fromWavFileInput(filePath);
    const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

    recognizer.recognizeOnceAsync(
      (result) => {
        recognizer.close();

        if (result.reason === sdk.ResultReason.RecognizedSpeech) {
          resolve(result.text.trim());
          return;
        }

        reject(new Error(result.errorDetails || 'No speech was recognized from the recording.'));
      },
      (error) => {
        recognizer.close();
        reject(error);
      }
    );
  });
}

app.post('/api/transcribe-audio', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Audio recording is required.' });
  }

  return res.status(400).json({
    error: 'Speech-to-text is handled in the browser.',
    detail: 'Use the browser microphone input and allow speech recognition, or type text manually. Azure is not required for this project.'
  });
});

app.post('/api/generate-tts', async (req, res) => {
  const { text, lang, accent } = req.body;

  if (!text || !lang) {
    return res.status(400).json({ error: 'Text and language are required' });
  }

  try {
    const translatedText = await translateTextToLanguage(text, lang);

    let audioUrl = null;
    const preferAzure = String(process.env.USE_AZURE_TTS || '').toLowerCase() === 'true';
    if (preferAzure && hasAzureSpeechConfig()) {
      audioUrl = await getAzureAudioUrl(translatedText, lang, accent);
    } else {
      audioUrl = await getGoogleAudioUrl(translatedText, lang, accent);
    }

    const queryText = 'INSERT INTO tts_history(input_text, language_code, audio_url) VALUES($1, $2, $3) RETURNING *';
    const values = [translatedText, lang, audioUrl];
    const dbResult = await pool.query(queryText, values);

    res.json({
      success: true,
      audioUrl,
      originalText: text,
      translatedText,
      record: dbResult.rows[0],
    });
  } catch (error) {
    console.error('Error generating TTS:', error);
    res.status(500).json({ error: 'Failed to generate audio', detail: error.message });
  }
});

app.get('/api/history', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tts_history ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    app: 'talkback-tts',
    azureConfigured: hasAzureSpeechConfig(),
    databaseConfigured: Boolean(process.env.DATABASE_URL),
  });
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tts_history (
      id SERIAL PRIMARY KEY,
      input_text TEXT NOT NULL,
      language_code VARCHAR(10) NOT NULL,
      audio_url TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
