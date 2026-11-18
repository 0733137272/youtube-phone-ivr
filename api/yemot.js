const express = require('express');
const { YemotRouter } = require('yemot-router2');
const { downloadRecording, deleteFile } = require('../lib/yemotApi');
const { transcribeAudio } = require('../lib/groq');

const app = express();
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

  // Step 3 (M0): Read back the recognized text to verify accuracy
  const safeTranscript = transcript.replace(/[.:'"?!()\[\]{}&=]/g, ' ').replace(/\s+/g, ' ').trim();
  return call.id_list_message([
    { type: 'text', data: `זיהיתי שביקשתם ${safeTranscript}` },
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
