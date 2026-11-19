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

async function processSong(videoId, yemotToken, opts = {}) {
  const db = getDb();
  const rawPath = `/tmp/${videoId}_raw`;
  const phoneWav = `/tmp/${videoId}_phone.wav`;
  const cookiesPath = '/tmp/yt_cookies.txt';

  try {
    await db.execute({
      sql: `INSERT INTO jobs (video_id, status) VALUES (?, 'running')`,
      args: [videoId],
    });

    const ytArgs = [
      '--js-runtimes', 'node:/usr/local/bin/node',
      '-f', 'bestaudio[ext=m4a]/bestaudio/best',
      '--no-playlist',
      '-o', rawPath,
      `https://www.youtube.com/watch?v=${videoId}`,
    ];

    if (opts.useCookies !== false && (process.env.YT_COOKIES_B64 || process.env.YT_COOKIES)) {
      if (process.env.YT_COOKIES_B64) {
        fs.writeFileSync(cookiesPath, Buffer.from(process.env.YT_COOKIES_B64, 'base64').toString('utf8'), 'utf8');
      } else {
        fs.writeFileSync(cookiesPath, process.env.YT_COOKIES, 'utf8');
      }
      ytArgs.unshift('--cookies', cookiesPath);
    } else {
      ytArgs.splice(2, 0, '--extractor-args', 'youtube:player_client=android_vr');
    }

    const cleanEnv = { ...process.env };
    delete cleanEnv.NODE_OPTIONS;

    await execFileAsync('yt-dlp', ytArgs, { timeout: 120000, env: cleanEnv });

    // Convert directly to phone-ready 8kHz mono 16-bit WAV (fast, low-memory)
    await execFileAsync('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-y', '-i', rawPath,
      '-ar', '8000',
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      phoneWav,
    ], { timeout: 60000 });

    const yemotFilePath = `ivr2:4/6/6/songs/${videoId}.wav`;
    await uploadToYemot(yemotToken, phoneWav, yemotFilePath);

    const playPath = `4/6/6/songs/${videoId}`;
    await db.execute({
      sql: `INSERT INTO videos (video_id, channel_id, title, norm_title, cached_path, play_count)
            VALUES (?, 'netfree', ?, ?, ?, 1)
            ON CONFLICT(video_id) DO UPDATE SET
              cached_path = excluded.cached_path,
              play_count = videos.play_count + 1`,
      args: [videoId, videoId, videoId, playPath],
    });
    await db.execute({
      sql: `UPDATE jobs SET status = 'done', updated_at = CURRENT_TIMESTAMP WHERE video_id = ? AND status = 'running'`,
      args: [videoId],
    });

    return playPath;
  } catch (err) {
    const fullErr = `${err.message}\nSTDOUT:\n${err.stdout || ''}\nSTDERR:\n${err.stderr || ''}`;
    await db.execute({
      sql: `UPDATE jobs SET status = 'failed', error = ?, updated_at = CURRENT_TIMESTAMP WHERE video_id = ? AND status = 'running'`,
      args: [fullErr, videoId],
    });
    throw new Error(fullErr);
  } finally {
    for (const f of [rawPath, phoneWav]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  }
}

module.exports = { processSong };
