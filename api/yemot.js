const express = require('express');
const { YemotRouter } = require('yemot-router2');
const { downloadRecording, deleteFile } = require('../lib/yemotApi');
const { transcribeAudio } = require('../lib/groq');
const { getDb, initDb, searchLocal } = require('../lib/db');
const { resolveChannel, indexChannel } = require('../lib/youtube');
const { processSong } = require('../lib/mediaWorker');

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

app.get('/api/admin/test-download', async (req, res) => {
  const secret = process.env.API_SECRET;
  if (secret && req.query.key !== secret) {
    return res.status(403).send('Forbidden');
  }
  const videoId = req.query.video_id || 'Y30pfWIQfoo';
  const useCookies = req.query.nocookies !== '1';
  try {
    await ensureDb();
    const playPath = await processSong(videoId, process.env.YEMOT_TOKEN, { useCookies });
    res.json({ ok: true, playPath });
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

function sanitizeForTTS(str) {
  return String(str || '')
    .replace(/[^\u0590-\u05FFa-zA-Z0-9\s,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

router.get('/', async (call) => {
  const token = process.env.YEMOT_TOKEN;
  const groqKey = process.env.GROQ_API_KEY;

  if (!token || !groqKey) {
    return call.id_list_message([
      { type: 'text', data: 'המערכת עדיין לא הוגדרה, חסרים מפתחות בשרת' },
    ]);
  }

  // Step 1: Record the caller's song request (plays recorded welcome guide /4/6/6/welcome if uploaded, plus clear instruction)
  const recordingPath = await call.read(
    [{ type: 'file', data: '/4/6/6/welcome' }],
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
  const safeTranscript = sanitizeForTTS(transcript);
  const results = await searchLocal(transcript, 5);

  if (results.length === 0) {
    return call.id_list_message([
      { type: 'text', data: `זיהיתי ${safeTranscript} אך לא נמצא שיר מתאים בערוצים המורשים` },
    ]);
  }

  for (let i = 0; i < results.length; i++) {
    const song = results[i];
    const safeTitle = sanitizeForTTS(song.title);
    const choice = await call.read(
      [{ type: 'text', data: `מצאתי ${safeTitle}, לאישור הקישו 1, לתוצאה הבאה הקישו 2, ליציאה הקישו 3` }],
      'tap',
      { max_digits: 1, min_digits: 1, digits_allowed: ['1', '2', '3'] }
    );
    if (choice === '1') {
      const db = getDb();
      let playPath = song.cached_path;
      const safeFileId = String(song.video_id).replace(/[^a-zA-Z0-9_]/g, '_');

      if (!playPath) {
        // Start background download/conversion if not already running
        const running = await db.execute({
          sql: `SELECT id FROM jobs WHERE video_id = ? AND status IN ('running', 'part1_ready') LIMIT 1`,
          args: [song.video_id],
        });
        if (running.rows.length === 0) {
          processSong(song.video_id, token).catch((err) => {
            console.error('Background processSong error:', err);
          });
        }

        const waitFiles = [
          '/4/6/6/wait1',
          '/4/6/6/wait2',
          '/4/6/6/wait3',
        ];

        let part1Ready = false;
        for (let round = 0; round < 5 && !playPath && !part1Ready; round++) {
          const waitFile = waitFiles[Math.min(round, waitFiles.length - 1)];
          await call.read(
            [
              { type: 'file', data: waitFile },
              { type: 'music_on_hold', data: { musicName: 'NigunRoshChodeshKislevB', maxSec: 6 } },
            ],
            'tap',
            { max_digits: 1, sec_wait: 1, allow_empty: true, empty_val: '0' }
          );

          for (let attempt = 0; attempt < 2; attempt++) {
            const check = await db.execute({
              sql: `SELECT cached_path FROM videos WHERE video_id = ? LIMIT 1`,
              args: [song.video_id],
            });
            if (check.rows[0]?.cached_path) {
              playPath = check.rows[0].cached_path;
              break;
            }
            const jobRes = await db.execute({
              sql: `SELECT status FROM jobs WHERE video_id = ? ORDER BY id DESC LIMIT 1`,
              args: [song.video_id],
            });
            const jobStatus = jobRes.rows[0]?.status;
            if (jobStatus === 'part1_ready' || jobStatus === 'done') {
              part1Ready = true;
              break;
            }
            if (jobStatus === 'failed') {
              return call.id_list_message([
                { type: 'text', data: 'מצטערים, השיר אינו זמין להורדה כרגע' },
              ]);
            }
            await new Promise((r) => setTimeout(r, 2000));
          }
        }

        // Fast-start playback: play first 40s immediately while the rest & full file finish uploading in background!
        if (part1Ready && !playPath) {
          const part1Path = `/4/6/6/songs/${safeFileId}_part1`;
          const restPath = `/4/6/6/songs/${safeFileId}_rest`;

          await call.read(
            [{ type: 'file', data: part1Path }],
            'tap',
            { max_digits: 1, sec_wait: 1, allow_empty: true, empty_val: '0' }
          );

          // Wait briefly if _rest is still finishing its upload
          for (let w = 0; w < 5; w++) {
            const jobRes = await db.execute({
              sql: `SELECT status FROM jobs WHERE video_id = ? ORDER BY id DESC LIMIT 1`,
              args: [song.video_id],
            });
            if (jobRes.rows[0]?.status === 'done') break;
            await new Promise((r) => setTimeout(r, 2000));
          }

          return call.id_list_message([
            { type: 'file', data: restPath },
          ]);
        }
      }

      if (!playPath) {
        return call.id_list_message([
          { type: 'text', data: 'הכנת השיר לוקחת יותר זמן מהרגיל, נסו שוב בעוד דקה' },
        ]);
      }

      const normalizedPlayPath = playPath.startsWith('/') ? playPath : `/${playPath}`;
      return call.id_list_message([
        { type: 'file', data: normalizedPlayPath },
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
