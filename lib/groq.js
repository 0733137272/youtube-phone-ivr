const GROQ_STT_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

/**
 * Transcribes an audio buffer using Groq Whisper large-v3-turbo.
 * @param {Buffer} audioBuffer
 * @param {string} apiKey
 * @param {string} [prompt] - Optional hint with common artist/song names
 * @returns {Promise<string>}
 */
async function transcribeAudio(audioBuffer, apiKey, prompt = '') {
  const form = new FormData();
  const blob = new Blob([audioBuffer], { type: 'audio/wav' });
  form.append('file', blob, 'recording.wav');
  form.append('model', 'whisper-large-v3-turbo');
  form.append('language', 'he');
  form.append('response_format', 'json');
  if (prompt) {
    form.append('prompt', prompt);
  }

  const res = await fetch(GROQ_STT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq STT failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return (data.text || '').trim();
}

module.exports = { transcribeAudio };
