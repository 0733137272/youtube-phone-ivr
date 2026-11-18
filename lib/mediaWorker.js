const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');

const execFileAsync = promisify(execFile);
const YEMOT_BASE = 'https://www.call2all.co.il/ym/api';

async function uploadToYemot(token, localPath, yemotPath) {
  const fileBuffer = fs.readFileSync(localPath);
  const form = new FormData();
  form.append('token', token);
  form.append('path', yemotPath);
  form.append('convertAudio', '1');
  form.append('file', new Blob([fileBuffer], { type: 'audio/wav' }), path.basename(localPath));

  const res = await fetch(`${YEMOT_BASE}/UploadFile`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Yemot UploadFile HTTP ${res.status}`);
  }
  const data = await res.json();
  if (data.responseStatus !== 'OK') {
    throw new Error(`Yemot UploadFile error: ${JSON.stringify(data)}`);
  }
  return data;
}

async function processSong(videoId, yemotToken) {
  const db = getDb();
  const rawPath = `/tmp/${videoId}_raw.%(ext)s`;
  const wavRaw = `/tmp/${videoId}_raw.wav`;
  const phoneWav = `/tmp/${videoId}_phone.wav`;
  const cookiesPath = '/tmp/yt_cookies.txt';

  try {
    await db.execute({
      sql: `INSERT INTO jobs (video_id, status) VALUES (?, 'running')`,
      args: [videoId],
    });

    const ytArgs = [
      '--js-runtimes', 'node',
      '-f', 'bestaudio/best',
      '-x', '--audio-format', 'wav',
      '--no-playlist',
      '-o', rawPath,
      `https://www.youtube.com/watch?v=${videoId}`,
    ];

    if (process.env.YT_COOKIES) {
      fs.writeFileSync(cookiesPath, process.env.YT_COOKIES, 'utf8');
      ytArgs.unshift('--cookies', cookiesPath);
    }

    await execFileAsync('yt-dlp', ytArgs, { timeout: 120000 });

    // Convert to phone-ready 8kHz mono 16-bit WAV with loudnorm
    await execFileAsync('ffmpeg', [
      '-y', '-i', wavRaw,
      '-af', 'loudnorm',
      '-ar', '8000',
      '-ac', '1',
      '-sample_fmt', 's16',
      phoneWav,
    ], { timeout: 60000 });

    const yemotFilePath = `ivr2:4/6/6/songs/${videoId}.wav`;
    await uploadToYemot(yemotToken, phoneWav, yemotFilePath);

    const playPath = `4/6/6/songs/${videoId}`;
    await db.execute({
      sql: `UPDATE videos SET cached_path = ?, play_count = play_count + 1 WHERE video_id = ?`,
      args: [playPath, videoId],
    });
    await db.execute({
      sql: `UPDATE jobs SET status = 'done', updated_at = CURRENT_TIMESTAMP WHERE video_id = ? AND status = 'running'`,
      args: [videoId],
    });

    return playPath;
  } catch (err) {
    await db.execute({
      sql: `UPDATE jobs SET status = 'failed', error = ?, updated_at = CURRENT_TIMESTAMP WHERE video_id = ? AND status = 'running'`,
      args: [err.message, videoId],
    });
    throw err;
  } finally {
    for (const f of [wavRaw, phoneWav]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  }
}

module.exports = { processSong };
