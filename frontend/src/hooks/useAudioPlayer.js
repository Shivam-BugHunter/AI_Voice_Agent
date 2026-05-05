import { useRef, useCallback } from 'react';

/**
 * Custom hook to play raw PCM audio chunks streamed from the backend.
 * Uses the Web Audio API (AudioContext) for low-latency playback.
 * 
 * PCM format: 16-bit signed integer, 16kHz, mono
 */
export function useAudioPlayer() {
  const audioContextRef = useRef(null);
  const nextPlayTimeRef = useRef(0);
  const isPlayingRef = useRef(false);

  const getContext = useCallback(() => {
    if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 16000,
      });
      nextPlayTimeRef.current = 0;
    }
    // Resume if suspended (browsers require user gesture)
    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume();
    }
    return audioContextRef.current;
  }, []);

  /**
   * Queue a PCM audio chunk for playback.
   * Chunks are scheduled back-to-back to avoid gaps.
   */
  const playChunk = useCallback((pcmBuffer) => {
    const ctx = getContext();
    
    // Convert the raw PCM (Int16) buffer to Float32 for Web Audio API
    const int16Array = new Int16Array(pcmBuffer);
    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
      float32Array[i] = int16Array[i] / 32768.0;
    }

    // Create an AudioBuffer and fill it
    const audioBuffer = ctx.createBuffer(1, float32Array.length, 16000);
    audioBuffer.getChannelData(0).set(float32Array);

    // Schedule playback
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    const startTime = Math.max(now, nextPlayTimeRef.current);
    source.start(startTime);
    nextPlayTimeRef.current = startTime + audioBuffer.duration;
    isPlayingRef.current = true;

    source.onended = () => {
      // Check if this was the last scheduled chunk
      if (ctx.currentTime >= nextPlayTimeRef.current - 0.01) {
        isPlayingRef.current = false;
      }
    };
  }, [getContext]);

  /**
   * Flush all queued audio and stop playback immediately.
   * Used for barge-in when user interrupts the bot.
   */
  const flush = useCallback(() => {
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    nextPlayTimeRef.current = 0;
    isPlayingRef.current = false;
  }, []);

  return { playChunk, flush };
}
