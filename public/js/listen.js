/**
 * Cruzo — Mobile Receiver Logic
 * WebRTC Audio Receiver, Candidate Queueing, playoutDelayHint, DelayNode, MediaSession Keep-Alive
 */

// Global State
let socket = null;
let peerConnection = null;
let audioContext = null;
let mediaStreamSource = null;
let delayNode = null;
let gainNode = null;
let analyserNode = null;
let isGraphConnected = false;
let visualizerAnimationId = null;
let currentDelayMs = 0;
let currentVolumeMultiplier = 1.0;
let isMuted = false;
let isAudioUnlocked = false;
let wakeLock = null;
let rttPingMs = 0;
let pingInterval = null;
let activeRemoteStream = null;

// Candidate Queueing to prevent dropped candidates before setRemoteDescription
let pendingIceCandidates = [];
let isRemoteDescriptionSet = false;

// DOM Elements
const clientStatusBadge = document.getElementById('clientStatusBadge');
const clientStatusText = document.getElementById('clientStatusText');
const clientPingText = document.getElementById('clientPingText');
const unmuteHeroSection = document.getElementById('unmuteHeroSection');
const btnUnmuteHero = document.getElementById('btnUnmuteHero');
const streamingActiveCard = document.getElementById('streamingActiveCard');
const clientVisualizerCanvas = document.getElementById('clientVisualizerCanvas');
const syncDelaySlider = document.getElementById('syncDelaySlider');
const delayBadgeValue = document.getElementById('delayBadgeValue');
const volumeSlider = document.getElementById('volumeSlider');
const volumePercentDisplay = document.getElementById('volumePercentDisplay');
const btnMuteToggle = document.getElementById('btnMuteToggle');
const btnReconnect = document.getElementById('btnReconnect');
const wakeLockStatus = document.getElementById('wakeLockStatus');
const jitterBufferStatus = document.getElementById('jitterBufferStatus');
const iceStateStatus = document.getElementById('iceStateStatus');
const hiddenSilentAudio = document.getElementById('hiddenSilentAudio');

// Initialize on Load
document.addEventListener('DOMContentLoaded', () => {
  setupCanvas(clientVisualizerCanvas);
  window.addEventListener('resize', () => setupCanvas(clientVisualizerCanvas));
  window.addEventListener('orientationchange', () => setTimeout(() => setupCanvas(clientVisualizerCanvas), 200));
  setupEventListeners();
  initSocket();
});

// -----------------------------------------------------------------------------
// 1. Socket.io Signaling
// -----------------------------------------------------------------------------
function initSocket() {
  socket = io();

  socket.on('connect', () => {
    console.log('[Cruzo] Connected to signaling server as Watcher:', socket.id);
    updateClientStatus('CONNECTING', false);

    const deviceName = detectDeviceName();
    socket.emit('watcher-join', {
      deviceName,
      userAgent: navigator.userAgent
    });

    startPingHeartbeat();
  });

  // Host presence status
  socket.on('broadcaster-status', (status) => {
    if (status.active) {
      updateClientStatus('HOST ONLINE', true);
    } else {
      updateClientStatus('WAITING FOR HOST', false);
    }
  });

  socket.on('broadcaster-available', () => {
    updateClientStatus('HOST ONLINE', true);
    socket.emit('watcher-join', {
      deviceName: detectDeviceName(),
      userAgent: navigator.userAgent
    });
  });

  socket.on('broadcaster-disconnected', () => {
    updateClientStatus('HOST OFFLINE', false);
    closePeerConnection();
  });

  // Received WebRTC Offer from Host
  socket.on('offer', async (data) => {
    console.log('[Cruzo] Received WebRTC offer from broadcaster');
    await handleWebRtcOffer(data);
  });

  // Received ICE Candidate from Host
  socket.on('ice-candidate', async (data) => {
    if (data && data.candidate) {
      if (peerConnection && isRemoteDescriptionSet) {
        try {
          await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (err) {
          console.warn('[Cruzo] Error adding ICE candidate:', err);
        }
      } else {
        // Queue candidate until setRemoteDescription completes
        pendingIceCandidates.push(data.candidate);
      }
    }
  });

  // Pong response for RTT measurement
  socket.on('telemetry-pong', (data) => {
    const now = Date.now();
    rttPingMs = Math.max(1, now - data.timestamp);
    clientPingText.textContent = `${rttPingMs} ms`;

    // Report back to Host PC console
    socket.emit('watcher-telemetry', {
      rtt: rttPingMs,
      delayOffset: currentDelayMs
    });
  });

  // Host kicked this client
  socket.on('kicked', () => {
    alert('You have been disconnected by the Host.');
    closePeerConnection();
    updateClientStatus('DISCONNECTED', false);
  });

  socket.on('disconnect', () => {
    updateClientStatus('OFFLINE', false);
    if (pingInterval) clearInterval(pingInterval);
  });
}

function startPingHeartbeat() {
  if (pingInterval) clearInterval(pingInterval);
  pingInterval = setInterval(() => {
    if (socket && socket.connected) {
      socket.emit('telemetry-ping', { timestamp: Date.now() });
    }
  }, 2500);
}

// -----------------------------------------------------------------------------
// 2. WebRTC Peer Connection & Playout Delay Optimization
// -----------------------------------------------------------------------------
async function handleWebRtcOffer(data) {
  closePeerConnection();
  isRemoteDescriptionSet = false;
  pendingIceCandidates = [];

  const rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ],
    iceCandidatePoolSize: 0,
    bundlePolicy: 'max-bundle'
  };

  peerConnection = new RTCPeerConnection(rtcConfig);

  // Send local ICE candidates to Host
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', {
        targetId: data.broadcasterId,
        candidate: event.candidate
      });
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    const state = peerConnection.iceConnectionState;
    iceStateStatus.textContent = `ICE: ${state}`;
    console.log(`[Cruzo] ICE Connection State: ${state}`);

    if (state === 'connected' || state === 'completed') {
      updateClientStatus('STREAMING', true);
    } else if (state === 'checking') {
      updateClientStatus('CONNECTING...', false);
    } else if (state === 'disconnected') {
      updateClientStatus('RECONNECTING', false);
    } else if (state === 'failed') {
      updateClientStatus('FAILED - RETRY', false);
    }
  };

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;
    console.log(`[Cruzo] Peer Connection State: ${state}`);
    if (state === 'connected') {
      updateClientStatus('STREAMING', true);
    }
  };

  // Incoming media track
  peerConnection.ontrack = (event) => {
    console.log('[Cruzo] Received audio track:', event.track);

    // Force Chromium's internal jitter buffer down to 20ms
    if (event.receiver && 'playoutDelayHint' in event.receiver) {
      event.receiver.playoutDelayHint = 0.02;
      jitterBufferStatus.textContent = '⚡ Playout Hint: 20ms';
    }

    activeRemoteStream = event.streams[0];
    if (isAudioUnlocked) {
      setupAudioPipeline(activeRemoteStream);
    }
  };

  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
    isRemoteDescriptionSet = true;
    console.log('[Cruzo] Set remote description successfully');

    // Drain queued ICE candidates
    while (pendingIceCandidates.length > 0) {
      const cand = pendingIceCandidates.shift();
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(cand));
      } catch (err) {
        console.warn('[Cruzo] Error draining queued candidate:', err);
      }
    }

    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    socket.emit('answer', {
      sdp: answer
    });
  } catch (err) {
    console.error('[Cruzo] WebRTC negotiation error:', err);
  }
}

function closePeerConnection() {
  if (peerConnection) {
    try {
      peerConnection.close();
    } catch (e) {}
    peerConnection = null;
  }
  isRemoteDescriptionSet = false;
  pendingIceCandidates = [];
}

// -----------------------------------------------------------------------------
// 3. Web Audio API Pipeline & DelayNode
// -----------------------------------------------------------------------------
function setupAudioPipeline(stream) {
  if (!stream) return;
  ensureAudioContext();

  try {
    // Cleanly disconnect previous media stream source if any
    if (mediaStreamSource) {
      try {
        mediaStreamSource.disconnect();
      } catch (e) {}
      mediaStreamSource = null;
    }

    mediaStreamSource = audioContext.createMediaStreamSource(stream);

    // Create DelayNode (supports up to 1.0s personal delay)
    if (!delayNode) {
      delayNode = audioContext.createDelay(1.0);
      delayNode.delayTime.setValueAtTime(currentDelayMs / 1000, audioContext.currentTime);
    }

    // Create GainNode (Volume & Boost)
    if (!gainNode) {
      gainNode = audioContext.createGain();
      gainNode.gain.setValueAtTime(isMuted ? 0 : currentVolumeMultiplier, audioContext.currentTime);
    }

    // Create AnalyserNode (Live Visualizer)
    if (!analyserNode) {
      analyserNode = audioContext.createAnalyser();
      analyserNode.fftSize = 128;
      analyserNode.smoothingTimeConstant = 0.75;
    }

    // Connect source to delay
    mediaStreamSource.connect(delayNode);

    // Connect downstream graph only once to prevent signal duplication
    if (!isGraphConnected) {
      delayNode.connect(gainNode);
      gainNode.connect(analyserNode);
      analyserNode.connect(audioContext.destination);
      isGraphConnected = true;
    }

    startVisualizerLoop();
    updateClientStatus('STREAMING', true);
  } catch (err) {
    console.error('[Cruzo] Audio pipeline error:', err);
  }
}

function updatePersonalDelay(ms) {
  currentDelayMs = Math.max(0, Math.min(400, ms));
  delayBadgeValue.textContent = `${currentDelayMs} ms`;
  syncDelaySlider.value = currentDelayMs;

  if (delayNode && audioContext) {
    delayNode.delayTime.setTargetAtTime(currentDelayMs / 1000, audioContext.currentTime, 0.015);
  }

  // Report to host
  if (socket && socket.connected) {
    socket.emit('watcher-telemetry', {
      rtt: rttPingMs,
      delayOffset: currentDelayMs
    });
  }

  // Update preset pill active highlight
  document.querySelectorAll('.btn-preset').forEach(btn => {
    const p = parseInt(btn.getAttribute('data-preset'), 10);
    if (p === currentDelayMs) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

function updateVolume(val) {
  const percent = parseInt(val, 10);
  volumePercentDisplay.textContent = `${percent}%`;
  currentVolumeMultiplier = percent / 100;

  if (gainNode && audioContext && !isMuted) {
    gainNode.gain.setTargetAtTime(currentVolumeMultiplier, audioContext.currentTime, 0.01);
  }
}

function toggleMute() {
  isMuted = !isMuted;
  if (gainNode && audioContext) {
    gainNode.gain.setTargetAtTime(isMuted ? 0 : currentVolumeMultiplier, audioContext.currentTime, 0.01);
  }

  if (isMuted) {
    btnMuteToggle.classList.add('btn-danger');
    btnMuteToggle.classList.remove('btn-secondary');
    btnMuteToggle.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"></line><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon></svg> Unmute`;
  } else {
    btnMuteToggle.classList.remove('btn-danger');
    btnMuteToggle.classList.add('btn-secondary');
    btnMuteToggle.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg> Mute`;
  }
}

// -----------------------------------------------------------------------------
// 4. Autoplay Unlock, WakeLock & Background MediaSession API
// -----------------------------------------------------------------------------
async function unlockAudio() {
  ensureAudioContext();

  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  // Play a brief silent audio buffer to unlock iOS/Android hardware DAC
  try {
    const buffer = audioContext.createBuffer(1, 1, 22050);
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    source.start(0);
  } catch (e) {
    console.log('Buffer unlock caught:', e);
  }

  // Play silent audio element loop for Android/iOS background tab keep-alive
  try {
    await hiddenSilentAudio.play();
  } catch (e) {
    console.log('Silent audio unlock caught:', e);
  }

  // Request Screen WakeLock
  requestScreenWakeLock();

  // Configure Navigator MediaSession API
  setupMediaSession();

  isAudioUnlocked = true;
  unmuteHeroSection.style.display = 'none';
  streamingActiveCard.style.display = 'block';

  // Wire up audio pipeline immediately if stream already arrived
  if (activeRemoteStream) {
    setupAudioPipeline(activeRemoteStream);
  }
}

function ensureAudioContext() {
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000
    });
  }
}

async function requestScreenWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLockStatus.textContent = '🔋 WakeLock: Active';
      wakeLock.addEventListener('release', () => {
        wakeLockStatus.textContent = '🔋 WakeLock: Standby';
      });
    } catch (err) {
      console.log('WakeLock error:', err);
      wakeLockStatus.textContent = '🔋 WakeLock: N/A';
    }
  }
}

// Re-acquire WakeLock automatically when user returns to tab
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && isAudioUnlocked) {
    requestScreenWakeLock();
  }
  if (audioContext && audioContext.state === 'suspended' && isAudioUnlocked) {
    audioContext.resume();
  }
});

function setupMediaSession() {
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'Cruzo Wireless Audio',
      artist: 'Host PC Movie Stream',
      album: 'Local LAN Zero-Data Matrix'
    });

    navigator.mediaSession.setActionHandler('play', () => {
      if (audioContext && audioContext.state === 'suspended') {
        audioContext.resume();
      }
    });

    navigator.mediaSession.setActionHandler('pause', () => {
      // Keep playing even if pause requested
    });
  }
}

// -----------------------------------------------------------------------------
// 5. Visualizer
// -----------------------------------------------------------------------------
function setupCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = (rect.width || 400) * dpr;
  canvas.height = (rect.height || 70) * dpr;
}

function startVisualizerLoop() {
  if (!analyserNode || visualizerAnimationId) return;

  const canvas = clientVisualizerCanvas;
  const ctx = canvas.getContext('2d');
  const bufferLength = analyserNode.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  function render() {
    visualizerAnimationId = requestAnimationFrame(render);
    analyserNode.getByteFrequencyData(dataArray);

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const barWidth = (canvas.width / bufferLength) * 2.5;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      const barHeight = (dataArray[i] / 255) * canvas.height;

      const gradient = ctx.createLinearGradient(0, canvas.height, 0, 0);
      gradient.addColorStop(0, '#0284c7');
      gradient.addColorStop(0.6, '#10b981');
      gradient.addColorStop(1, '#34d399');

      ctx.fillStyle = gradient;
      ctx.fillRect(x, canvas.height - barHeight, barWidth - 1, barHeight);

      x += barWidth;
    }
  }

  render();
}

// -----------------------------------------------------------------------------
// 6. Event Listeners & UI Helpers
// -----------------------------------------------------------------------------
function setupEventListeners() {
  // Hero Unmute
  btnUnmuteHero.addEventListener('click', unlockAudio);

  // Sync Slider
  syncDelaySlider.addEventListener('input', (e) => {
    updatePersonalDelay(parseInt(e.target.value, 10));
  });

  // Micro adjustments (-20ms, -5ms, +5ms, +20ms)
  document.querySelectorAll('.btn-fine').forEach(btn => {
    btn.addEventListener('click', () => {
      const delta = parseInt(btn.getAttribute('data-delta'), 10);
      updatePersonalDelay(currentDelayMs + delta);
    });
  });

  // Preset pills
  document.querySelectorAll('.btn-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = parseInt(btn.getAttribute('data-preset'), 10);
      updatePersonalDelay(preset);
    });
  });

  // Volume
  volumeSlider.addEventListener('input', (e) => {
    updateVolume(e.target.value);
  });

  // Mute
  btnMuteToggle.addEventListener('click', toggleMute);

  // Reconnect
  btnReconnect.addEventListener('click', () => {
    console.log('[Cruzo] User triggered manual reconnect');
    if (socket && socket.connected) {
      socket.emit('watcher-join', {
        deviceName: detectDeviceName(),
        userAgent: navigator.userAgent
      });
    }
  });
}

function updateClientStatus(text, isLive) {
  clientStatusText.textContent = text;
  if (isLive) {
    clientStatusBadge.className = 'status-badge live';
  } else {
    clientStatusBadge.className = 'status-badge';
  }
}

function detectDeviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/i.test(ua)) return 'Apple iPhone';
  if (/iPad/i.test(ua)) return 'Apple iPad';
  if (/Samsung/i.test(ua)) return 'Samsung Galaxy';
  if (/Pixel/i.test(ua)) return 'Google Pixel';
  if (/OnePlus/i.test(ua)) return 'OnePlus Phone';
  if (/Android/i.test(ua)) return 'Android Device';
  return 'Mobile Listener';
}
