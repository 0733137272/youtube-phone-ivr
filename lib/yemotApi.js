const YEMOT_BASE = 'https://www.call2all.co.il/ym/api';

/**
 * Downloads a recorded file from Yemot HaMashiach.
 * @param {string} token - Yemot API token (systemNumber:password)
 * @param {string} filePath - Path returned by Yemot (e.g. "ivr2:/1/001.wav")
 * @returns {Promise<Buffer>}
 */
async function downloadRecording(token, filePath) {
  const url = `${YEMOT_BASE}/DownloadFile?token=${encodeURIComponent(token)}&path=${encodeURIComponent(filePath)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Yemot DownloadFile failed: ${res.status} ${res.statusText}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Deletes a file from Yemot HaMashiach to save storage.
 * @param {string} token - Yemot API token
 * @param {string} filePath - Path on Yemot (e.g. "ivr2:/1/001.wav")
 */
async function deleteFile(token, filePath) {
  const url = `${YEMOT_BASE}/FileAction?token=${encodeURIComponent(token)}&action=delete&what=${encodeURIComponent(filePath)}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`Yemot FileAction delete warning: ${res.status}`);
  }
}

module.exports = { downloadRecording, deleteFile };
