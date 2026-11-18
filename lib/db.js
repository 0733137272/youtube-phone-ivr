const { createClient } = require('@libsql/client');

let client = null;

function getDb() {
  if (!client) {
    client = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  }
  return client;
}

async function initDb() {
  const db = getDb();
  await db.batch([
    `CREATE TABLE IF NOT EXISTS channels (
      channel_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      uploads_playlist_id TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      added_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_indexed_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS videos (
      video_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      title TEXT NOT NULL,
      norm_title TEXT NOT NULL,
      duration_sec INTEGER DEFAULT 0,
      published_at TEXT,
      view_count INTEGER DEFAULT 0,
      cached_path TEXT,
      play_count INTEGER DEFAULT 0,
      indexed_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT NOT NULL,
      status TEXT DEFAULT 'queued',
      error TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS requests_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT DEFAULT CURRENT_TIMESTAMP,
      transcript TEXT,
      top_match TEXT,
      outcome TEXT
    )`,
  ], 'write');
}

const NOISE_WORDS = /\b(official|video|audio|lyrics|hd|4k|live|קליפ רשמי|הקליפ הרשמי|מילים|גרסה רשמית)\b/gi;

function normalizeText(str) {
  if (!str) return '';
  return str
    .replace(/[\u0591-\u05C7]/g, '') // remove Hebrew niqqud
    .replace(NOISE_WORDS, ' ')
    .replace(/[^\u0590-\u05FFa-zA-Z0-9\s]/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

async function searchLocal(query, limit = 5) {
  const db = getDb();
  const normQuery = normalizeText(query);
  if (!normQuery) return [];

  const tokens = normQuery.split(' ').filter((t) => t.length >= 2);
  if (tokens.length === 0) return [];

  // Fetch candidate videos matching at least one token
  const whereClauses = tokens.map(() => `(v.norm_title LIKE ? OR c.display_name LIKE ?)`).join(' OR ');
  const args = [];
  for (const t of tokens) {
    args.push(`%${t}%`, `%${t}%`);
  }

  const res = await db.execute({
    sql: `SELECT v.video_id, v.title, v.norm_title, v.duration_sec, v.view_count, v.cached_path, c.display_name AS channel_name
          FROM videos v
          JOIN channels c ON v.channel_id = c.channel_id
          WHERE c.enabled = 1 AND v.duration_sec BETWEEN 30 AND 720 AND (${whereClauses})
          LIMIT 100`,
    args,
  });

  // Score results by token overlap + exact substring + popularity
  const scored = res.rows.map((row) => {
    const haystack = `${row.norm_title} ${normalizeText(row.channel_name)}`;
    let score = 0;
    for (const t of tokens) {
      if (haystack.includes(t)) score += 1;
    }
    if (haystack.includes(normQuery)) score += 2;
    score += Math.min(Number(row.view_count || 0) / 1000000, 0.5);
    return { ...row, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

module.exports = { getDb, initDb, normalizeText, searchLocal };
