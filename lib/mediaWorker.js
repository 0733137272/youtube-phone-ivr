const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');
const { deleteFile } = require('./yemotApi');

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
  const part1Wav = `/tmp/${videoId}_part1.wav`;
  const restWav = `/tmp/${videoId}_rest.wav`;
  const phoneWav = `/tmp/${videoId}_phone.wav`;
  const cookiesPath = '/tmp/yt_cookies.txt';
  const safeFileId = videoId.replace(/[^a-zA-Z0-9_]/g, '_');

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

    // Step 1: Slice and upload the first 40 seconds for fast-start playback (~2s)
    await execFileAsync('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-y', '-i', rawPath,
      '-t', '40',
      '-ar', '8000', '-ac', '1', '-c:a', 'pcm_s16le',
      part1Wav,
    ], { timeout: 30000 });

    const yemotPart1Path = `ivr2:4/6/6/songs/${safeFileId}_part1.wav`;
    await uploadToYemot(yemotToken, part1Wav, yemotPart1Path);

    await db.execute({
      sql: `UPDATE jobs SET status = 'part1_ready', updated_at = CURRENT_TIMESTAMP WHERE video_id = ? AND status = 'running'`,
      args: [videoId],
    });

    // Step 2: While caller listens to first 40s, convert and upload the rest (from 40s to end)
    await execFileAsync('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-y', '-ss', '40', '-i', rawPath,
      '-ar', '8000', '-ac', '1', '-c:a', 'pcm_s16le',
      restWav,
    ], { timeout: 60000 });

    const yemotRestPath = `ivr2:4/6/6/songs/${safeFileId}_rest.wav`;
    if (fs.existsSync(restWav) && fs.statSync(restWav).size > 1000) {
      await uploadToYemot(yemotToken, restWav, yemotRestPath);
    }

    await db.execute({
      sql: `UPDATE jobs SET status = 'done', updated_at = CURRENT_TIMESTAMP WHERE video_id = ? AND status IN ('running', 'part1_ready')`,
      args: [videoId],
    });

    // Step 3: Convert and upload the single full song file for permanent archive
    await execFileAsync('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-y', '-i', rawPath,
      '-ar', '8000', '-ac', '1', '-c:a', 'pcm_s16le',
      phoneWav,
    ], { timeout: 60000 });

    const yemotFullPath = `ivr2:4/6/6/songs/${safeFileId}.wav`;
    await uploadToYemot(yemotToken, phoneWav, yemotFullPath);

    const playPath = `/4/6/6/songs/${safeFileId}`;
    await db.execute({
      sql: `INSERT INTO videos (video_id, channel_id, title, norm_title, cached_path, play_count)
            VALUES (?, 'netfree', ?, ?, ?, 1)
            ON CONFLICT(video_id) DO UPDATE SET
              cached_path = excluded.cached_path,
              play_count = videos.play_count + 1`,
      args: [videoId, videoId, videoId, playPath],
    });

    // Clean up temporary part1 and rest files on Yemot after 20 minutes so only the full file remains
    setTimeout(() => {
      deleteFile(yemotToken, yemotPart1Path).catch(() => {});
      deleteFile(yemotToken, yemotRestPath).catch(() => {});
    }, 20 * 60 * 1000).unref();

    return playPath;
  } catch (err) {
    const fullErr = `${err.message}\nSTDOUT:\n${err.stdout || ''}\nSTDERR:\n${err.stderr || ''}`;
    await db.execute({
      sql: `UPDATE jobs SET status = 'failed', error = ?, updated_at = CURRENT_TIMESTAMP WHERE video_id = ? AND status IN ('running', 'part1_ready')`,
      args: [fullErr, videoId],
    });
    throw new Error(fullErr);
  } finally {
    for (const f of [rawPath, part1Wav, restWav, phoneWav]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  }
}

module.exports = { processSong };
