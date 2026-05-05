/**
 * TTS Service - Deepgram Aura (Replacement for ElevenLabs)
 * 
 * Uses Deepgram's Aura TTS model. It's extremely fast and reliable.
 * Since the user already has a working Deepgram STT key, this is the best fallback.
 */
const { EventEmitter } = require('events');
const axios = require('axios');

function streamTTS(textStream) {
  const emitter = new EventEmitter();
  const apiKey = process.env.DEEPGRAM_API_KEY;
  const voice = 'aura-asteria-en'; // Friendly female voice

  if (!apiKey || apiKey === 'your_deepgram_api_key_here') {
    console.warn('[TTS] ⚠️  DEEPGRAM_API_KEY not set. TTS will be disabled.');
    (async () => {
      for await (const chunk of textStream) {
        emitter.emit('text', chunk);
      }
      emitter.emit('done');
    })();
    return emitter;
  }

  let fullText = '';
  let isDone = false;

  (async () => {
    try {
      // Deepgram Speak API is REST-based but returns a stream.
      // We accumulate the text from the LLM and send it to Deepgram.
      // For the absolute lowest latency, we could use their WebSocket if available,
      // but their REST API with 'aura' is already <200ms.
      
      for await (const textChunk of textStream) {
        fullText += textChunk;
        emitter.emit('text', textChunk);
      }

      if (!fullText.trim()) {
        emitter.emit('done');
        return;
      }

      console.log(`[TTS] 🎙️ Requesting Deepgram Aura TTS for: "${fullText.substring(0, 30)}..."`);
      
      const response = await axios({
        method: 'post',
        url: `https://api.deepgram.com/v1/speak?model=${voice}&encoding=linear16&sample_rate=16000`,
        headers: {
          'Authorization': `Token ${apiKey}`,
          'Content-Type': 'application/json'
        },
        data: JSON.stringify({ text: fullText }),
        responseType: 'stream'
      });

      response.data.on('data', (chunk) => {
        emitter.emit('audio', chunk);
      });

      response.data.on('end', () => {
        console.log('[TTS] ✅ Deepgram Audio complete');
        emitter.emit('done');
      });

      response.data.on('error', (err) => {
        console.error('[TTS] ❌ Deepgram Stream error:', err.message);
        emitter.emit('done');
      });

    } catch (err) {
      console.error('[TTS] ❌ Deepgram TTS Error:', err.response?.data || err.message);
      emitter.emit('done');
    }
  })();

  return emitter;
}

module.exports = { streamTTS };
