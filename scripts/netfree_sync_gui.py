import os
import re
import json
import ssl
import threading
import urllib.request
import urllib.parse
import tkinter as tk
from tkinter import ttk, messagebox, scrolledtext

ssl_ctx = ssl._create_unverified_context()

CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "netfree_sync_config.json")

DEFAULT_CONFIG = {
    "turso_url": "https://youtube-ivr-x0733137272.aws-eu-central-1.turso.io",
    "turso_token": "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3OTQ5OTM3NzksImlkIjoiMDFhMWVkZjctNmYwMS03MmNmLWI4YjAtZTI1MmY5MTNiNjllIiwia2lkIjoidUExR2FRRVFEMldIX2ZGaU11dVRMYkdxemI5ckg5SV9Oa1JUQ01GdExqQSIsInJpZCI6IjMwMjIxNDc1LTFjMjQtNGFhZS04YzdjLTUwZTg1MWQ3MGYxOSJ9.SQtgXt7FJ-qWlh2JYpfJB8hR4YZk3bWaRpwozcvdJmACcpGTZtFMPahgK-xW6Gd46juhuHGW63J9j0XyvffQDg",
    "yt_api_key": "AIzaSyC061xxKgnxnOWAzxLgECseqGS-PVRyEYQ",
    "max_per_channel": 15,
}


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                cfg.update(json.load(f))
        except Exception:
            pass
    return cfg


def save_config_file(cfg):
    try:
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2, ensure_ascii=False)
    except Exception:
        pass


def normalize_text(s):
    s = re.sub(r"[\u0591-\u05C7]", "", s or "")
    s = re.sub(
        r"\b(official|video|audio|lyrics|hd|4k|live|קליפ רשמי|הקליפ הרשמי|מילים|גרסה רשמית)\b",
        " ",
        s,
        flags=re.I,
    )
    s = re.sub(r"[^\u0590-\u05FFa-zA-Z0-9\s]", " ", s).lower()
    return re.sub(r"\s+", " ", s).strip()


def turso_exec(turso_url, turso_token, sql, args=None):
    base = turso_url.strip().replace("libsql://", "https://").rstrip("/")
    if not base.endswith("/v2/pipeline"):
        base += "/v2/pipeline"
    stmt = {"sql": sql}
    if args:
        stmt["args"] = [
            {"type": "text" if isinstance(a, str) else "integer", "value": str(a)}
            for a in args
        ]
    body = json.dumps(
        {"requests": [{"type": "execute", "stmt": stmt}, {"type": "close"}]}
    ).encode("utf-8")
    req = urllib.request.Request(
        base,
        data=body,
        headers={
            "Authorization": f"Bearer {turso_token.strip()}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, context=ssl_ctx, timeout=15) as r:
        return json.loads(r.read().decode("utf-8"))


def is_open_in_netfree(video_id):
    """Checks from a NetFree-connected PC whether the YouTube video is approved and open."""
    url = f"https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={video_id}&format=json"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, context=ssl_ctx, timeout=8) as r:
            if "netfree" in r.geturl().lower():
                return False
            data = json.loads(r.read().decode("utf-8"))
            return bool(data.get("title"))
    except Exception:
        return False


class NetFreeSyncApp:
    def __init__(self, root):
        self.root = root
        self.root.title("סנכרון שירים חדשים מנטפרי למערכת הטלפונית (Turso)")
        self.root.geometry("760x620")
        self.cfg = load_config()
        self.is_running = False

        main_frame = ttk.Frame(root, padding=12)
        main_frame.pack(fill=tk.BOTH, expand=True)

        # Settings group
        settings_box = ttk.LabelFrame(main_frame, text=" הגדרות חיבור ומפתחות API (Turso & YouTube) ", padding=10)
        settings_box.pack(fill=tk.X, pady=(0, 10))

        ttk.Label(settings_box, text="כתובת מסד Turso:").grid(row=0, column=0, sticky=tk.W, pady=3)
        self.turso_url_var = tk.StringVar(value=self.cfg["turso_url"])
        ttk.Entry(settings_box, textvariable=self.turso_url_var, width=68).grid(row=0, column=1, padx=6, pady=3)

        ttk.Label(settings_box, text="מפתח API של Turso:").grid(row=1, column=0, sticky=tk.W, pady=3)
        self.turso_token_var = tk.StringVar(value=self.cfg["turso_token"])
        ttk.Entry(settings_box, textvariable=self.turso_token_var, width=68).grid(row=1, column=1, padx=6, pady=3)

        ttk.Label(settings_box, text="מפתח YouTube API:").grid(row=2, column=0, sticky=tk.W, pady=3)
        self.yt_key_var = tk.StringVar(value=self.cfg["yt_api_key"])
        ttk.Entry(settings_box, textvariable=self.yt_key_var, width=68).grid(row=2, column=1, padx=6, pady=3)

        btn_row = ttk.Frame(settings_box)
        btn_row.grid(row=3, column=0, columnspan=2, sticky=tk.W, pady=(6, 0))
        ttk.Button(btn_row, text="שמור הגדרות", command=self.on_save_settings).pack(side=tk.LEFT, padx=(0, 8))
        ttk.Button(btn_row, text="בדוק חיבור ל-Turso", command=self.on_test_turso).pack(side=tk.LEFT)

        # Add Channel group
        add_box = ttk.LabelFrame(main_frame, text=" הוספת ערוץ יוטיוב חדש לרשימת המעקב ", padding=10)
        add_box.pack(fill=tk.X, pady=(0, 10))

        ttk.Label(add_box, text="מזהה ערוץ (@handle או UC...):").pack(side=tk.LEFT)
        self.new_ch_var = tk.StringVar()
        ttk.Entry(add_box, textvariable=self.new_ch_var, width=35).pack(side=tk.LEFT, padx=8)
        ttk.Button(add_box, text="הוסף ערוץ ל-Turso", command=self.on_add_channel).pack(side=tk.LEFT)

        # Action & Progress
        action_box = ttk.Frame(main_frame)
        action_box.pack(fill=tk.X, pady=(0, 8))

        self.sync_btn = tk.Button(
            action_box,
            text="▶ הפעל סנכרון שירים חדשים (בדיקת נטפרי ועדכון Turso)",
            bg="#1a73e8",
            fg="white",
            font=("Segoe UI", 11, "bold"),
            padx=14,
            pady=6,
            command=self.on_start_sync,
        )
        self.sync_btn.pack(fill=tk.X)

        self.progress = ttk.Progressbar(main_frame, orient=tk.HORIZONTAL, mode="determinate")
        self.progress.pack(fill=tk.X, pady=(0, 8))

        # Log area
        log_box = ttk.LabelFrame(main_frame, text=" יומן פעילות ", padding=6)
        log_box.pack(fill=tk.BOTH, expand=True)

        self.log_text = scrolledtext.ScrolledText(log_box, height=16, font=("Consolas", 10))
        self.log_text.pack(fill=tk.BOTH, expand=True)
        self.log("התוכנה מוכנה. לחץ על 'הפעל סנכרון שירים חדשים' כדי לבדוק ולהוסיף שירים חדשים שפתוחים בנטפרי.")

    def log(self, msg):
        def _append():
            self.log_text.insert(tk.END, msg + "\n")
            self.log_text.see(tk.END)
        self.root.after(0, _append)

    def get_current_cfg(self):
        return {
            "turso_url": self.turso_url_var.get().strip(),
            "turso_token": self.turso_token_var.get().strip(),
            "yt_api_key": self.yt_key_var.get().strip(),
            "max_per_channel": 15,
        }

    def on_save_settings(self):
        cfg = self.get_current_cfg()
        save_config_file(cfg)
        messagebox.showinfo("נשמר", "ההגדרות ומפתחות ה-API נשמרו בהצלחה!")

    def on_test_turso(self):
        cfg = self.get_current_cfg()
        try:
            res = turso_exec(cfg["turso_url"], cfg["turso_token"], "SELECT count(*) FROM channels")
            count = res["results"][0]["response"]["result"]["rows"][0][0]["value"]
            messagebox.showinfo("חיבור תקין", f"החיבור ל-Turso תקין!\nמספר ערוצים במעקב כרגע: {count}")
        except Exception as e:
            messagebox.showerror("שגיאת חיבור", f"לא ניתן להתחבר ל-Turso:\n{e}")

    def on_add_channel(self):
        ch_input = self.new_ch_var.get().strip()
        if not ch_input:
            return
        cfg = self.get_current_cfg()
        param = f"id={urllib.parse.quote(ch_input)}" if ch_input.startswith("UC") else f"forHandle={urllib.parse.quote(ch_input.lstrip('@'))}"
        url = f"https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails&{param}&key={cfg['yt_api_key']}"
        try:
            with urllib.request.urlopen(url, context=ssl_ctx, timeout=10) as r:
                data = json.loads(r.read().decode("utf-8"))
            items = data.get("items", [])
            if not items:
                messagebox.showwarning("לא נמצא", f"הערוץ {ch_input} לא נמצא ביוטיוב.")
                return
            ch = items[0]
            cid = ch["id"]
            title = ch["snippet"]["title"]
            upl = ch["contentDetails"]["relatedPlaylists"]["uploads"]
            turso_exec(
                cfg["turso_url"],
                cfg["turso_token"],
                "INSERT INTO channels (channel_id, display_name, uploads_playlist_id, enabled) VALUES (?, ?, ?, 1) ON CONFLICT(channel_id) DO UPDATE SET display_name = excluded.display_name, enabled = 1",
                [cid, title, upl],
            )
            self.new_ch_var.set("")
            self.log(f"✓ נוסף ערוץ חדש למעקב: {title} ({cid})")
            messagebox.showinfo("נוסף בהצלחה", f"הערוץ '{title}' נוסף למעקב ב-Turso!")
        except Exception as e:
            messagebox.showerror("שגיאה", f"שגיאה בהוספת הערוץ:\n{e}")

    def on_start_sync(self):
        if self.is_running:
            return
        self.is_running = True
        self.sync_btn.config(state=tk.DISABLED, text="סורק ומסנכרן כעת...")
        t = threading.Thread(target=self.run_sync_worker, daemon=True)
        t.start()

    def run_sync_worker(self):
        cfg = self.get_current_cfg()
        save_config_file(cfg)
        try:
            res = turso_exec(
                cfg["turso_url"],
                cfg["turso_token"],
                "SELECT channel_id, display_name, uploads_playlist_id FROM channels WHERE enabled = 1",
            )
            channels = res["results"][0]["response"]["result"]["rows"]
            total_ch = len(channels)
            self.log(f"--- מתחיל סריקה של {total_ch} ערוצים במעקב ---")
            self.root.after(0, lambda: self.progress.config(maximum=max(1, total_ch), value=0))

            # Fetch existing video IDs in Turso so we only check truly new ones
            existing_res = turso_exec(cfg["turso_url"], cfg["turso_token"], "SELECT video_id FROM videos")
            existing_rows = existing_res["results"][0]["response"]["result"]["rows"]
            existing_ids = {r[0]["value"] for r in existing_rows}

            added_total = 0
            blocked_total = 0

            for idx, row in enumerate(channels, start=1):
                ch_id, ch_name, pl_id = row[0]["value"], row[1]["value"], row[2]["value"]
                self.log(f"[{idx}/{total_ch}] בודק העלאות חדשות בערוץ: {ch_name}...")
                yt_url = (
                    f"https://www.googleapis.com/youtube/v3/playlistItems"
                    f"?part=snippet,contentDetails&playlistId={pl_id}&maxResults=10&key={cfg['yt_api_key']}"
                )
                try:
                    with urllib.request.urlopen(yt_url, context=ssl_ctx, timeout=10) as r:
                        items = json.loads(r.read().decode("utf-8")).get("items", [])
                except Exception as e:
                    self.log(f"  ! שגיאה בשליפת ערוץ {ch_name}: {e}")
                    self.root.after(0, lambda v=idx: self.progress.config(value=v))
                    continue

                for it in items:
                    vid = it["contentDetails"].get("videoId")
                    title = it["snippet"].get("title", "")
                    if not vid or not title or vid in existing_ids:
                        continue
                    if is_open_in_netfree(vid):
                        turso_exec(
                            cfg["turso_url"],
                            cfg["turso_token"],
                            """INSERT INTO videos (video_id, channel_id, title, norm_title)
                               VALUES (?, ?, ?, ?)
                               ON CONFLICT(video_id) DO UPDATE SET title = excluded.title, norm_title = excluded.norm_title""",
                            [vid, ch_id, title, normalize_text(title)],
                        )
                        existing_ids.add(vid)
                        added_total += 1
                        self.log(f"  ✓ פתוח בנטפרי ונוסף ל-Turso: {title}")
                    else:
                        blocked_total += 1
                        self.log(f"  ✗ חסום בנטפרי (דולג): {title}")

                self.root.after(0, lambda v=idx: self.progress.config(value=v))

            self.log(f"=== הסנכרון הושלם! נוספו {added_total} שירים חדשים שפתוחים בנטפרי (דולגו {blocked_total} חסומים) ===")
        except Exception as e:
            self.log(f"!!! שגיאה בסנכרון: {e}")
        finally:
            self.is_running = False
            self.root.after(
                0,
                lambda: self.sync_btn.config(
                    state=tk.NORMAL,
                    text="▶ הפעל סנכרון שירים חדשים (בדיקת נטפרי ועדכון Turso)",
                ),
            )


if __name__ == "__main__":
    root = tk.Tk()
    app = NetFreeSyncApp(root)
    root.mainloop()
