"""
Weekly NetFree YouTube Sync Script (runs on a NetFree-connected PC).
1. Queries YouTube Data API v3 for recent uploads from tracked channels in Turso.
2. Verifies each new video is actually open/approved in NetFree via NetFree's video filter check from this PC.
3. Saves all newly approved videos directly to Turso so the phone IVR finds them immediately.
"""
import os, re, json, ssl, urllib.request, urllib.parse

ssl_ctx = ssl._create_unverified_context()

YT_API_KEY = os.environ.get("YT_API_KEY", "AIzaSyC061xxKgnxnOWAzxLgECseqGS-PVRyEYQ")
TURSO_HTTP_URL = "https://youtube-ivr-x0733137272.aws-eu-central-1.turso.io/v2/pipeline"
TURSO_TOKEN = os.environ.get(
    "TURSO_AUTH_TOKEN",
    "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3OTQ5OTM3NzksImlkIjoiMDFhMWVkZjctNmYwMS03MmNmLWI4YjAtZTI1MmY5MTNiNjllIiwia2lkIjoidUExR2FRRVFEMldIX2ZGaU11dVRMYkdxemI5ckg5SV9Oa1JUQ01GdExqQSIsInJpZCI6IjMwMjIxNDc1LTFjMjQtNGFhZS04YzdjLTUwZTg1MWQ3MGYxOSJ9.SQtgXt7FJ-qWlh2JYpfJB8hR4YZk3bWaRpwozcvdJmACcpGTZtFMPahgK-xW6Gd46juhuHGW63J9j0XyvffQDg"
)

def normalize_text(s):
    s = re.sub(r"[\u0591-\u05C7]", "", s or "")
    s = re.sub(r"\b(official|video|audio|lyrics|hd|4k|live|קליפ רשמי|הקליפ הרשמי|מילים|גרסה רשמית)\b", " ", s, flags=re.I)
    s = re.sub(r"[^\u0590-\u05FFa-zA-Z0-9\s]", " ", s).lower()
    return re.sub(r"\s+", " ", s).strip()

def turso_exec(sql, args=None):
    stmt = {"sql": sql}
    if args:
        stmt["args"] = [{"type": "text" if isinstance(a, str) else "integer", "value": str(a)} for a in args]
    body = json.dumps({"requests": [{"type": "execute", "stmt": stmt}, {"type": "close"}]}).encode("utf-8")
    req = urllib.request.Request(
        TURSO_HTTP_URL,
        data=body,
        headers={"Authorization": f"Bearer {TURSO_TOKEN}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, context=ssl_ctx) as r:
        return json.loads(r.read().decode("utf-8"))

def is_open_in_netfree(video_id):
    """Checks from a NetFree-connected PC whether the YouTube video is open in NetFree."""
    url = f"https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={video_id}&format=json"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, context=ssl_ctx, timeout=8) as r:
            # If NetFree blocks a video, it redirects or returns a block status/418
            if "netfree" in r.geturl().lower():
                return False
            data = json.loads(r.read().decode("utf-8"))
            return bool(data.get("title"))
    except Exception:
        return False

def sync_recent_videos():
    res = turso_exec("SELECT channel_id, display_name, uploads_playlist_id FROM channels WHERE enabled = 1")
    rows = res["results"][0]["response"]["result"]["rows"]
    print(f"Found {len(rows)} active channels in Turso to check for new NetFree videos...")
    added = 0
    for row in rows:
        ch_id, ch_name, pl_id = row[0]["value"], row[1]["value"], row[2]["value"]
        yt_url = f"https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId={pl_id}&maxResults=15&key={YT_API_KEY}"
        try:
            with urllib.request.urlopen(yt_url, context=ssl_ctx) as r:
                items = json.loads(r.read().decode("utf-8")).get("items", [])
        except Exception as e:
            print(f"Error fetching {ch_name}: {e}")
            continue

        for it in items:
            vid = it["contentDetails"].get("videoId")
            title = it["snippet"].get("title", "")
            if not vid or not title:
                continue
            if is_open_in_netfree(vid):
                turso_exec(
                    """INSERT INTO videos (video_id, channel_id, title, norm_title)
                       VALUES (?, ?, ?, ?)
                       ON CONFLICT(video_id) DO UPDATE SET title = excluded.title, norm_title = excluded.norm_title""",
                    [vid, ch_id, title, normalize_text(title)],
                )
                added += 1
        print(f"Checked channel: {ch_name}")
    print(f"Sync complete! Added/verified {added} NetFree-approved videos in Turso.")

if __name__ == "__main__":
    sync_recent_videos()
