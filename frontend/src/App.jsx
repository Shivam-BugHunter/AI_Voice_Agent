import React, { useEffect, useRef, useState, useCallback } from 'react';
import { io } from 'socket.io-client';
import { useAudioRecorder } from './hooks/useAudioRecorder';
import { useAudioPlayer } from './hooks/useAudioPlayer';
import './App.css';

const BACKEND_URL = 'http://localhost:3001';

function App() {
  const socketRef = useRef(null);
  const [isConnected, setIsConnected] = useState(false);
  const [services, setServices] = useState({});

  // Transcript state
  const [transcripts, setTranscripts] = useState([]); // Array of { role, text }
  const [partialTranscript, setPartialTranscript] = useState('');
  const [agentText, setAgentText] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);

  const transcriptEndRef = useRef(null);
  const { playChunk, flush } = useAudioPlayer();

  // Auto-scroll transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcripts, partialTranscript, agentText]);

  // Send audio to backend
  const onAudioData = useCallback((buffer) => {
    if (socketRef.current?.connected) {
      socketRef.current.emit('audio_stream', buffer);
    }
  }, []);

  const { isRecording, startRecording, stopRecording } = useAudioRecorder(onAudioData);

  // Connect socket + wire up events
  useEffect(() => {
    const socket = io(BACKEND_URL);
    socketRef.current = socket;

    socket.on('connect', () => setIsConnected(true));
    socket.on('disconnect', () => setIsConnected(false));

    // STT events
    socket.on('transcript_partial', (text) => setPartialTranscript(text));
    socket.on('transcript_final', (text) => {
      setPartialTranscript('');
      setTranscripts(prev => {
        // Merge consecutive user messages
        const last = prev[prev.length - 1];
        if (last && last.role === 'user') {
          return [...prev.slice(0, -1), { role: 'user', text: last.text + ' ' + text }];
        }
        return [...prev, { role: 'user', text }];
      });
    });

    // LLM/TTS events
    socket.on('agent_thinking', () => {
      setIsThinking(true);
      setAgentText('');
    });

    socket.on('agent_text', (chunk) => {
      setIsThinking(false);
      setIsSpeaking(true);
      setAgentText(prev => prev + chunk);
    });

    socket.on('agent_audio', (audioBuffer) => {
      playChunk(audioBuffer);
    });

    socket.on('agent_done', () => {
      setIsThinking(false);
      setIsSpeaking(false);
      setAgentText(prev => {
        const finalText = prev.trim();
        if (finalText) {
          setTranscripts(prevTranscripts => {
            // Deduplication check: Don't add if the last message is identical
            const lastMessage = prevTranscripts[prevTranscripts.length - 1];
            if (lastMessage && lastMessage.role === 'agent' && lastMessage.text === finalText) {
              return prevTranscripts;
            }
            return [...prevTranscripts, { role: 'agent', text: finalText }];
          });
        }
        return '';
      });
    });

    socket.on('error', (data) => {
      console.error('Server error:', data);
    });

    // Check backend service status
    fetch(`${BACKEND_URL}/health`)
      .then(r => r.json())
      .then(d => setServices(d.services || {}))
      .catch(() => {});

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('transcript_partial');
      socket.off('transcript_final');
      socket.off('agent_thinking');
      socket.off('agent_text');
      socket.off('agent_audio');
      socket.off('agent_done');
      socket.off('error');
      socket.disconnect();
    };
  }, [playChunk]);

  // Barge-in handler
  const handleBargeIn = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.emit('stop_agent');
    }
    flush();
    setIsThinking(false);
    setIsSpeaking(false);
    setAgentText(prev => {
      if (prev.trim()) {
        setTranscripts(t => [...t, { role: 'agent', text: prev.trim() + '...' }]);
      }
      return '';
    });
  }, [flush]);

  return (
    <div className="app-wrapper">
      <div className="app-container">
        {/* Header */}
        <header className="header">
          <h1 className="title">AI Voice Agent</h1>
          <p className="subtitle">Real-time conversational AI powered by GPT + Deepgram + ElevenLabs</p>
          <div className="status-row">
            <span className={`status-badge ${isConnected ? 'connected' : 'disconnected'}`}>
              {isConnected ? '● Connected' : '○ Disconnected'}
            </span>
            {services.deepgram && <span className="service-badge">STT ✓</span>}
            {services.openai && <span className="service-badge">LLM ✓</span>}
            {services.elevenlabs && <span className="service-badge">TTS ✓</span>}
          </div>
        </header>

        {/* Conversation Transcript */}
        <div className="transcript-box">
          <div className="transcript-content">
            {transcripts.length === 0 && !partialTranscript && !agentText && (
              <p className="placeholder-text">
                Press the microphone button and start speaking...
              </p>
            )}

            {transcripts.map((entry, idx) => (
              <div key={idx} className={`message ${entry.role}`}>
                <span className="message-label">
                  {entry.role === 'user' ? '🧑 You' : '🤖 Agent'}
                </span>
                <p className="message-text">{entry.text}</p>
              </div>
            ))}

            {/* Current partial user transcript */}
            {partialTranscript && (
              <div className="message user partial">
                <span className="message-label">🧑 You</span>
                <p className="message-text">{partialTranscript}...</p>
              </div>
            )}

            {/* Agent thinking indicator */}
            {isThinking && (
              <div className="message agent">
                <span className="message-label">🤖 Agent</span>
                <div className="thinking-dots">
                  <span></span><span></span><span></span>
                </div>
              </div>
            )}

            {/* Current agent response streaming */}
            {agentText && (
              <div className="message agent streaming">
                <span className="message-label">🤖 Agent</span>
                <p className="message-text">{agentText}<span className="cursor-blink">|</span></p>
              </div>
            )}

            <div ref={transcriptEndRef} />
          </div>
        </div>

        {/* Controls */}
        <div className="controls">
          {!isRecording ? (
            <button onClick={startRecording} className="btn btn-mic" title="Start listening">
              <svg viewBox="0 0 24 24" className="mic-icon" fill="currentColor">
                <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
                <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
              </svg>
            </button>
          ) : (
            <button onClick={stopRecording} className="btn btn-stop-mic" title="Stop listening">
              <div className="stop-icon"></div>
            </button>
          )}

          {(isSpeaking || isThinking) && (
            <button onClick={handleBargeIn} className="btn btn-interrupt" title="Interrupt agent">
              ✋ Interrupt
            </button>
          )}
        </div>

        {isRecording && (
          <div className="recording-indicator">
            <span className="pulse-ring"></span>
            <span className="recording-text">Listening...</span>
          </div>
        )}

        {isSpeaking && (
          <div className="speaking-indicator">
            <div className="sound-wave">
              <span></span><span></span><span></span><span></span><span></span>
            </div>
            <span className="speaking-text">Agent is speaking...</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
