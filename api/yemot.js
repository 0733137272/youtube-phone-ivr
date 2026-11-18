const express = require('express');
const { YemotRouter } = require('yemot-router2');
const { downloadRecording, deleteFile } = require('../lib/yemotApi');
const { transcribeAudio } = require('../lib/groq');
const { getDb, initDb, searchLocal } = require('../lib/db');
const { resolveChannel, indexChannel } = require('../lib/youtube');

const app = express();
let dbReady = false;
async function ensureDb() {
  if (!dbReady && process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN) {
    await initDb();
    dbReady = true;
  }
}
const router = YemotRouter({
  printLog: true,
  uncaughtErrorHandler: (error, call) => {
    console.error('Unhandled call error:', error);
    return call.id_list_message([
      { type: 'text', data: 'אירעה תקלה זמנית, אנא נסו שוב מאוחר יותר' },
    ]);
  },
});

let lastDebug = { recordingPath: null, error: null, at: null };

// Simple health check
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    hasYemotToken: Boolean(process.env.YEMOT_TOKEN),
    hasGroqKey: Boolean(process.env.GROQ_API_KEY),
  });
});

app.get('/api/debug', (req, res) => {
  const secret = process.env.API_SECRET;
  if (secret && req.query.key !== secret) {
    return res.status(403).send('Forbidden');
  }
  res.json(lastDebug);
});

app.get('/api/admin/add-channel', async (req, res) => {
  const secret = process.env.API_SECRET;
  if (secret && req.query.key !== secret) {
    return res.status(403).send('Forbidden');
  }
  const ch = req.query.channel;
  if (!ch) return res.status(400).json({ error: 'Missing channel param' });
  try {
    await ensureDb();
    const channel = await resolveChannel(process.env.YT_API_KEY, ch);
    const count = await indexChannel(getDb(), process.env.YT_API_KEY, channel, Number(req.query.pages || 3));
    res.json({ ok: true, channel: channel.display_name, channel_id: channel.channel_id, indexed_videos: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/search', async (req, res) => {
  const secret = process.env.API_SECRET;
  if (secret && req.query.key !== secret) {
    return res.status(403).send('Forbidden');
  }
  try {
    await ensureDb();
    const results = await searchLocal(req.query.q || '');
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Secret check middleware for Yemot endpoint
app.use('/api/yemot', (req, res, next) => {
  const secret = process.env.API_SECRET;
  if (secret && req.query.key !== secret) {
    return res.status(403).send('Forbidden');
  }
  next();
});

router.get('/', async (call) => {
  const token = process.env.YEMOT_TOKEN;
  const groqKey = process.env.GROQ_API_KEY;

  if (!token || !groqKey) {
    return call.id_list_message([
      { type: 'text', data: 'המערכת עדיין לא הוגדרה, חסרים מפתחות בשרת' },
    ]);
  }

  // Step 1: Record the caller's song request
  const recordingPath = await call.read(
    [{ type: 'text', data: 'ברוכים הבאים, אמרו את שם השיר המבוקש ולאחר מכן הקישו סולמית' }],
    'record',
    {
      maxLength: 10,
      minLength: 1,
      playBeep: true,
    }
  );

  if (!recordingPath) {
    return call.id_list_message([
      { type: 'text', data: 'לא התקבלה הקלטה, אנא נסו שוב' },
    ]);
  }

  // Step 2: Download from Yemot & transcribe with Groq Whisper
  let transcript = '';
  lastDebug = { recordingPath, error: null, at: new Date().toISOString() };
  try {
    const audioBuffer = await downloadRecording(token, recordingPath);
    transcript = await transcribeAudio(
      audioBuffer,
      groqKey,
      'אברהם פריד, יעקב שוואקי, מרדכי בן דוד, ישי ריבו, חנן בן ארי'
    );
  } catch (err) {
    console.error('STT error:', err);
    lastDebug.error = err.message;
    return call.id_list_message([
      { type: 'text', data: 'לא הצלחתי לפענח את ההקלטה כרגע, נסו שוב מאוחר יותר' },
    ]);
  } finally {
    // Clean up recording from Yemot storage
    deleteFile(token, recordingPath).catch(() => {});
  }

  if (!transcript) {
    return call.id_list_message([
      { type: 'text', data: 'לא שמעתי בקשה ברורה, נסו שוב' },
    ]);
  }

  // Step 3 (M1): Search local Turso index
  await ensureDb();
  const safeTranscript = transcript.replace(/[.:'"?!()\[\]{}&=]/g, ' ').replace(/\s+/g, ' ').trim();
  const results = await searchLocal(transcript, 5);

  if (results.length === 0) {
    return call.id_list_message([
      { type: 'text', data: `זיהיתי ${safeTranscript} אך לא נמצא שיר מתאים בערוצים המורשים` },
    ]);
  }

  for (let i = 0; i < results.length; i++) {
    const song = results[i];
    const safeTitle = String(song.title).replace(/[.:'"?!()\[\]{}&=]/g, ' ').replace(/\s+/g, ' ').trim();
    const choice = await call.read(
      [{ type: 'text', data: `מצאתי ${safeTitle}, לאישור הקישו 1, לתוצאה הבאה הקישו 2, ליציאה הקישו 3` }],
      'tap',
      { max_digits: 1, min_digits: 1, digits_allowed: ['1', '2', '3'] }
    );
    if (choice === '1') {
      return call.id_list_message([
        { type: 'text', data: `בחרתם ${safeTitle}, בשלב הבא נפעיל את ההשמעה` },
      ]);
    }
    if (choice === '3') {
      return call.id_list_message([{ type: 'text', data: 'תודה ולהתראות' }]);
    }
  }

  return call.id_list_message([
    { type: 'text', data: 'לא נותרות תוצאות נוספות, נסו לחפש שוב' },
  ]);
});

app.use('/api/yemot', router);

// Local development server
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`M0 server listening on http://localhost:${port}`);
  });
}

module.exports = app;
