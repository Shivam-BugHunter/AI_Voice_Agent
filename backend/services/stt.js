/**
 * STT Service - Deepgram Real-Time Transcription
 * 
 * Uses raw WebSocket connection to Deepgram's streaming API.
 * This approach avoids SDK version issues and gives us full control.
 * 
 * Deepgram Nova-2 model provides <300ms latency for real-time voice agents.
 */
const WebSocket = require('ws');

function setupSTT(onPartial, onFinal, onError) {
  const apiKey = process.env.DEEPGRAM_API_KEY;

  if (!apiKey || apiKey === 'your_deepgram_api_key_here') {
    console.warn('[STT] ⚠️  DEEPGRAM_API_KEY not set. STT will be disabled.');
    // Return a mock object so the server doesn't crash
    return {
      send: () => {},
      close: () => {},
      readyState: 0,
    };
  }

  const params = new URLSearchParams({
    model: 'nova-2',
    language: 'en',
    smart_format: 'true',
    endpointing: '300',
    interim_results: 'true',
    punctuate: 'true',
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
  });

  const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

  const ws = new WebSocket(url, {
    headers: { Authorization: `Token ${apiKey}` },
  });

  let keepAliveInterval;

  ws.on('open', () => {
    console.log('[STT] ✅ Deepgram WebSocket connected');
    // Keep connection alive by sending a dummy message every 10s
    keepAliveInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'KeepAlive' }));
      }
    }, 10000);
  });

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      // Deepgram sends results in channel.alternatives
      const transcript = data?.channel?.alternatives?.[0]?.transcript;
      if (!transcript) return;

      if (data.is_final) {
        console.log(`[STT] 📝 Final: "${transcript}"`);
        onFinal(transcript);
      } else {
        onPartial(transcript);
      }
    } catch (err) {
      // Ignore non-JSON messages (keepalive, metadata, etc.)
    }
  });

  ws.on('error', (err) => {
    console.error('[STT] ❌ Deepgram error:', err.message);
    if (onError) onError(err);
  });

  ws.on('close', (code, reason) => {
    console.log(`[STT] 🔌 Deepgram closed (code: ${code})`);
    clearInterval(keepAliveInterval);
  });

  return ws;
}

module.exports = { setupSTT };
