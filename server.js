const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const googleTTS = require('google-tts-api');
const { translate } = require('google-translate-api-x');
require('dotenv').config();                       // loads .env if present (cloud hosts inject vars directly)
require('dotenv').config({ path: './TalkBack.env' }); // loads local TalkBack.env if present

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // serve index.html and static files

// Connect to Neon PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Required for Neon connections
});

// TTS Generation Endpoint
app.post('/api/generate-tts', async (req, res) => {
  const { text, lang, accent } = req.body;

  if (!text || !lang) {
    return res.status(400).json({ error: 'Text and language are required' });
  }

  // Accent is selected via Google TTS regional hosts (mainly affects English)
  const TTS_HOSTS = {
    us: 'https://translate.google.com',
    uk: 'https://translate.google.co.uk',
    au: 'https://translate.google.com.au',
    in: 'https://translate.google.co.in',
    ca: 'https://translate.google.ca',
  };
  const host = TTS_HOSTS[accent] || TTS_HOSTS.us;

  try {
    // 1. Translate the input text into the selected language
    const translation = await translate(text, { to: lang });
    const spokenText = translation.text;

    // 2. Split long text into <=200 char chunks and merge the audio into one MP3
    const parts = await googleTTS.getAllAudioBase64(spokenText, {
      lang: lang,
      slow: false,
      host: host,
    });
    const merged = Buffer.concat(parts.map(p => Buffer.from(p.base64, 'base64')));
    const audioUrl = `data:audio/mpeg;base64,${merged.toString('base64')}`;

    // 3. Log the generation history into Neon Database
    const queryText = 'INSERT INTO tts_history(input_text, language_code, audio_url) VALUES($1, $2, $3) RETURNING *';
    const values = [spokenText, lang, audioUrl];
    const dbResult = await pool.query(queryText, values);

    // 4. Return the audio URL, translated text and database record to the frontend
    res.json({
      success: true,
      audioUrl: audioUrl,
      originalText: text,
      translatedText: spokenText,
      record: dbResult.rows[0]
    });

  } catch (error) {
    console.error('Error generating TTS:', error);
    res.status(500).json({ error: 'Failed to generate audio', detail: error.message });
  }
});

// Endpoint to fetch history from Neon
app.get('/api/history', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tts_history ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// Ensure the history table exists before accepting requests
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
