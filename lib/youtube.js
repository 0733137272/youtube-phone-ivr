const { normalizeText } = require('./db');

const YT_BASE = 'https://www.googleapis.com/youtube/v3';

function parseIsoDuration(iso) {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
}

async function resolveChannel(apiKey, handleOrId) {
  const param = handleOrId.startsWith('UC')
    ? `id=${encodeURIComponent(handleOrId)}`
    : `forHandle=${encodeURIComponent(handleOrId.replace(/^@/, ''))}`;

  const url = `${YT_BASE}/channels?part=snippet,contentDetails&${param}&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`YouTube channels.list failed: ${res.status}`);
  const data = await res.json();
  if (!data.items || data.items.length === 0) {
    throw new Error(`Channel not found: ${handleOrId}`);
  }
  const ch = data.items[0];
  return {
    channel_id: ch.id,
    display_name: ch.snippet.title,
    uploads_playlist_id: ch.contentDetails.relatedPlaylists.uploads,
  };
}

async function indexChannel(db, apiKey, channel, maxPages = 3) {
  await db.execute({
    sql: `INSERT INTO channels (channel_id, display_name, uploads_playlist_id, last_indexed_at)
          VALUES (?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(channel_id) DO UPDATE SET
            display_name = excluded.display_name,
            last_indexed_at = CURRENT_TIMESTAMP`,
    args: [channel.channel_id, channel.display_name, channel.uploads_playlist_id],
  });

  let pageToken = '';
  let totalIndexed = 0;

  for (let page = 0; page < maxPages; page++) {
    const plUrl = `${YT_BASE}/playlistItems?part=snippet,contentDetails&playlistId=${encodeURIComponent(channel.uploads_playlist_id)}&maxResults=50${pageToken ? `&pageToken=${pageToken}` : ''}&key=${encodeURIComponent(apiKey)}`;
    const plRes = await fetch(plUrl);
    if (!plRes.ok) throw new Error(`YouTube playlistItems.list failed: ${plRes.status}`);
    const plData = await plRes.json();

    const items = plData.items || [];
    if (items.length === 0) break;

    const videoIds = items.map((it) => it.contentDetails.videoId).filter(Boolean);
    const vUrl = `${YT_BASE}/videos?part=snippet,contentDetails,status,statistics&id=${videoIds.join(',')}&key=${encodeURIComponent(apiKey)}`;
    const vRes = await fetch(vUrl);
    if (!vRes.ok) throw new Error(`YouTube videos.list failed: ${vRes.status}`);
    const vData = await vRes.json();

    const stmts = [];
    for (const v of vData.items || []) {
      if (v.status?.privacyStatus !== 'public') continue;
      if (v.snippet?.liveBroadcastContent && v.snippet.liveBroadcastContent !== 'none') continue;
      const duration = parseIsoDuration(v.contentDetails?.duration || '');
      if (duration < 30 || duration > 720) continue;

      stmts.push({
        sql: `INSERT INTO videos (video_id, channel_id, title, norm_title, duration_sec, published_at, view_count)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(video_id) DO UPDATE SET
                title = excluded.title,
                norm_title = excluded.norm_title,
                view_count = excluded.view_count`,
        args: [
          v.id,
          channel.channel_id,
          v.snippet.title,
          normalizeText(v.snippet.title),
          duration,
          v.snippet.publishedAt || '',
          Number(v.statistics?.viewCount || 0),
        ],
      });
    }

    if (stmts.length > 0) {
      await db.batch(stmts, 'write');
      totalIndexed += stmts.length;
    }

    pageToken = plData.nextPageToken || '';
    if (!pageToken) break;
  }

  return totalIndexed;
}

module.exports = { resolveChannel, indexChannel };
