# YouTube Phone IVR — שלב M0 (בדיקת היתכנות)

שלב M0 בודק את החיבור מקצה לקצה:
**ימות המשיח (הקלטה) ← שרת Vercel ← הורדת הקלטה ← תמלול ב-Groq Whisper ← הקראה חזרה למתקשר.**

## פריסה מהירה ב-Vercel (חינם, ללא כרטיס אשראי)

1. העלה את התיקייה `youtube-phone-ivr` ל-GitHub (או פרוס ישירות עם `npx vercel`).
2. ב-Vercel, תחת **Settings → Environment Variables**, הוסף:
   - `YEMOT_TOKEN`: מספר המערכת והסיסמה בפורמט `0771234567:password`
   - `GROQ_API_KEY`: מפתח API חינמי מ-[console.groq.com](https://console.groq.com)
   - `API_SECRET`: מחרוזת אקראית כלשהי לאבטחת השלוחה
3. הגדר בשלוחה בימות המשיח (`ext.ini`):
   ```ini
   type=api
   api_link=https://<your-project>.vercel.app/api/yemot?key=<API_SECRET>
   ```
4. חייג לשלוחה, אמור שם של שיר, הקש `#`, ובדוק שהמערכת מקריאה לך חזרה את הטקסט המדויק.
