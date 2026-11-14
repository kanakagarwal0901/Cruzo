/**
 * Cruzo — Host PC Broadcaster Logic
 * Manages Master Web Audio Bus, WebRTC Star Topology, Stereo Opus SDP,
 * Real Frame-Delayed Cinema Video Engine, and Sync Clapper Matrix.
 */

// Global State
let socket = null;
let audioContext = null;
let masterDest = null;
let broadcastStream = null;
let desktopSourceNode = null;
let desktopRawStream = null;
let analyserNode = null;
let visualizerAnimationId = null;

// Peer Connections Map: watcherId -> RTCPeerConnection
const peerConnections = new Map();
// Pending ICE Candidates Map: watcherId -> Array<candidate>
const pendingIceCandidatesMap = new Map();

// Clapper Test State
let clapperInterval = null;
let isClapperRunning = false;

// Cinema Player State
let cinemaAudioSource = null;
let cinemaVideoDelayMs = 0;
let cinemaCanvasCtx = null;
let cinemaFrameQueue = [];
let cinemaDelayRafId = null;
let isScrubbing = false;

// DOM Elements
const hostStatusBadge = document.getElementById('hostStatusBadge');
const hostStatusText = document.getElementById('hostStatusText');
const hostLanIpText = document.getElementById('hostLanIpText');
const btnStartBroadcast = document.getElementById('btnStartBroadcast');
const btnStopBroadcast = document.getElementById('btnStopBroadcast');
const btnPlayTestChime = document.getElementById('btnPlayTestChime');
const qrCodeImg = document.getElementById('qrCodeImg');
const listenUrlDisplay = document.getElementById('listenUrlDisplay');
const btnCopyUrl = document.getElementById('btnCopyUrl');
const peersList = document.getElementById('peersList');
const noPeersNotice = document.getElementById('noPeersNotice');
const connectedCount = document.getElementById('connectedCount');
const hostVisualizerCanvas = document.getElementById('hostVisualizerCanvas');
const btnToggleClapper = document.getElementById('btnToggleClapper');
const clapperFlashBox = document.getElementById('clapperFlashBox');

// Tab Switching
const tabDesktopBtn = document.getElementById('tabDesktopBtn');
const tabCinemaBtn = document.getElementById('tabCinemaBtn');
const panelDesktop = document.getElementById('panelDesktop');
const panelCinema = document.getElementById('panelCinema');

// Cinema Player Elements
const cinemaDropzone = document.getElementById('cinemaDropzone');
const cinemaFileInput = document.getElementById('cinemaFileInput');
const cinemaPlayerWrapper = document.getElementById('cinemaPlayerWrapper');
const localCinemaVideo = document.getElementById('localCinemaVideo');
const cinemaDisplayCanvas = document.getElementById('cinemaDisplayCanvas');
const btnCinemaPlayPause = document.getElementById('btnCinemaPlayPause');
const cinemaPlayIcon = document.getElementById('cinemaPlayIcon');
const cinemaSeekBar = document.getElementById('cinemaSeekBar');
const cinemaTimeDisplay = document.getElementById('cinemaTimeDisplay');
const btnCinemaFullscreen = document.getElementById('btnCinemaFullscreen');
const cinemaDelaySlider = document.getElementById('cinemaDelaySlider');
const cinemaDelayValue = document.getElementById('cinemaDelayValue');

// Initialize on Load
document.addEventListener('DOMContentLoaded', () => {
  initAudioMasterBus();
  initSocket();
  fetchServerInfo();
  setupUIEventListeners();
  setupCanvas(hostVisualizerCanvas);
  window.addEventListener('resize', () => setupCanvas(hostVisualizerCanvas));
});

// Resume AudioContext on first interaction
document.addEventListener('click', () => {
  if (audioContext && audioContext.state === 'suspended') {
    audioContext.resume();
  }
}, { once: true });

// -----------------------------------------------------------------------------
// 1. Audio Master Bus Initialization
// -----------------------------------------------------------------------------
function initAudioMasterBus() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000
    });
  }

  if (!masterDest) {
    masterDest = audioContext.createMediaStreamDestination();
    broadcastStream = masterDest.stream;

    // Attach silent oscillator to keep broadcast audio track alive continuously
    const silenceOsc = audioContext.createOscillator();
    const silenceGain = audioContext.createGain();
    silenceGain.gain.value = 0.00001; // Inaudible keep-alive carrier
    silenceOsc.connect(silenceGain);
    silenceGain.connect(masterDest);
    silenceOsc.start();

    // Analyser Node for visualizer
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 256;
    analyserNode.smoothingTimeConstant = 0.8;
  }
}

function getActiveBroadcastTrack() {
  if (desktopRawStream && desktopRawStream.active && desktopRawStream.getAudioTracks().length > 0) {
    return desktopRawStream.getAudioTracks()[0];
  }
  if (broadcastStream && broadcastStream.getAudioTracks().length > 0) {
    return broadcastStream.getAudioTracks()[0];
  }
  return null;
}

// -----------------------------------------------------------------------------
// 2. Server Info & QR Code
// -----------------------------------------------------------------------------
async function fetchServerInfo() {
  try {
    const res = await fetch('/api/info');
    const data = await res.json();
    hostLanIpText.textContent = `${data.localIp}:${data.port}`;
    listenUrlDisplay.textContent = data.listenUrl;
    qrCodeImg.src = data.qrCodeDataUrl;
  } catch (err) {
    console.error('[Cruzo] Error fetching server info:', err);
    hostLanIpText.textContent = 'LAN IP Error';
  }
}

// -----------------------------------------------------------------------------
// 3. Socket.io Signaling Setup
// -----------------------------------------------------------------------------
function initSocket() {
  socket = io();

  socket.on('connect', () => {
    console.log('[Cruzo] Connected to signaling server as Host:', socket.id);
    socket.emit('broadcaster-register');
    updateHostStatus('READY', false);
  });

  socket.on('broadcaster-registered', (data) => {
    console.log('[Cruzo] Registered. Active watchers on server:', data.watcherCount);
    if (data.watchers && Array.isArray(data.watchers)) {
      data.watchers.forEach(watcherInfo => {
        addPeerToUI(watcherInfo);
        createPeerConnectionForWatcher(watcherInfo.id);
      });
    }
  });

  // Watcher joined room
  socket.on('watcher-joined', async (watcherInfo) => {
    console.log('[Cruzo] Watcher joined:', watcherInfo);
    addPeerToUI(watcherInfo);
    await createPeerConnectionForWatcher(watcherInfo.id);
  });

  // Watcher WebRTC Answer SDP
  socket.on('answer', async (data) => {
    const pc = peerConnections.get(data.watcherId);
    if (pc && data.sdp) {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        console.log(`[Cruzo] Remote description set for watcher ${data.watcherId}`);

        // Drain any queued ICE candidates for this watcher
        if (pendingIceCandidatesMap.has(data.watcherId)) {
          const queue = pendingIceCandidatesMap.get(data.watcherId);
          while (queue.length > 0) {
            const cand = queue.shift();
            try {
              await pc.addIceCandidate(new RTCIceCandidate(cand));
            } catch (err) {
              console.warn('[Cruzo] Error adding queued ICE candidate:', err);
            }
          }
        }
      } catch (err) {
        console.error(`[Cruzo] Failed to set remote description for ${data.watcherId}:`, err);
      }
    }
  });

  // Watcher ICE Candidate
  socket.on('ice-candidate', async (data) => {
    const pc = peerConnections.get(data.senderId);
    if (pc && data.candidate) {
      if (pc.remoteDescription && pc.remoteDescription.type) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (err) {
          console.error(`[Cruzo] Failed to add ICE candidate for ${data.senderId}:`, err);
        }
      } else {
        if (!pendingIceCandidatesMap.has(data.senderId)) {
          pendingIceCandidatesMap.set(data.senderId, []);
        }
        pendingIceCandidatesMap.get(data.senderId).push(data.candidate);
      }
    }
  });

  // Watcher disconnected
  socket.on('watcher-left', (data) => {
    removePeer(data.watcherId);
  });

  // Watcher updated its personal telemetry
  socket.on('watcher-telemetry-update', (data) => {
    updatePeerTelemetry(data.watcherId, data.rtt, data.delayOffset);
  });

  socket.on('disconnect', () => {
    updateHostStatus('DISCONNECTED', false);
  });
}

// -----------------------------------------------------------------------------
// 4. WebRTC Peer Connection & SDP Stereo Opus Manipulation
// -----------------------------------------------------------------------------
async function createPeerConnectionForWatcher(watcherId) {
  if (peerConnections.has(watcherId)) {
    try {
      peerConnections.get(watcherId).close();
    } catch (e) {}
    peerConnections.delete(watcherId);
  }

  pendingIceCandidatesMap.set(watcherId, []);

  const rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ],
    iceCandidatePoolSize: 0,
    bundlePolicy: 'max-bundle'
  };

  const pc = new RTCPeerConnection(rtcConfig);
  peerConnections.set(watcherId, pc);

  // Attach active audio track (native system audio or master bus)
  const trackToStream = getActiveBroadcastTrack();
  if (trackToStream) {
    pc.addTrack(trackToStream, broadcastStream);
  }

  // Handle local ICE candidates
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', {
        targetId: watcherId,
        candidate: event.candidate
      });
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log(`[Cruzo] Watcher ${watcherId} ICE state: ${pc.iceConnectionState}`);
    updatePeerStateBadge(watcherId, pc.iceConnectionState);
  };

  pc.onconnectionstatechange = () => {
    console.log(`[Cruzo] Watcher ${watcherId} Connection state: ${pc.connectionState}`);
    updatePeerStateBadge(watcherId, pc.connectionState);
  };

  try {
    const offer = await pc.createOffer({
      offerToReceiveAudio: false,
      offerToReceiveVideo: false
    });

    offer.sdp = enableStereoOpus(offer.sdp);
    await pc.setLocalDescription(offer);

    socket.emit('offer', {
      targetId: watcherId,
      sdp: offer
    });
  } catch (err) {
    console.error(`[Cruzo] Error creating offer for ${watcherId}:`, err);
  }
}

/**
 * Bulletproof Opus Stereo & High-Bitrate SDP Transformer
 * Compliant with RFC 7587 for 48kHz Stereo Opus @ 256kbps CBR
 */
function enableStereoOpus(sdp) {
  const opusPtMatch = sdp.match(/a=rtpmap:(\d+)\s+opus\/48000\/2/i);
  const pt = opusPtMatch ? opusPtMatch[1] : '111';

  const fmtpRegex = new RegExp('(a=fmtp:' + pt + '[ ]+)([^\\r\\n]*)([\\r\\n]*)', 'i');
  if (fmtpRegex.test(sdp)) {
    return sdp.replace(fmtpRegex, (match, prefix, params, ending) => {
      const paramMap = new Map();
      params.split(';').forEach(p => {
        const trimmed = p.trim();
        if (trimmed) {
          const parts = trimmed.split('=');
          if (parts[0]) paramMap.set(parts[0].trim(), parts[1] ? parts[1].trim() : '');
        }
      });

      paramMap.set('stereo', '1');
      paramMap.set('sprop-stereo', '1');
      paramMap.set('maxaveragebitrate', '256000');
      paramMap.set('cbr', '1');
      paramMap.set('minptime', '10');
      paramMap.set('useinbandfec', '1');

      const reconstructed = Array.from(paramMap.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
      return `${prefix}${reconstructed}${ending || '\r\n'}`;
    });
  } else {
    const rtpmapRegex = new RegExp('(a=rtpmap:' + pt + ' opus\\/48000\\/2[^\\r\\n]*\\r\\n)', 'i');
    return sdp.replace(
      rtpmapRegex,
      (match, g1) => `${g1}a=fmtp:${pt} stereo=1; sprop-stereo=1; maxaveragebitrate=256000; cbr=1; minptime=10; useinbandfec=1\r\n`
    );
  }
}

// -----------------------------------------------------------------------------
// 5. Audio Capture — Desktop Screen / Tab Audio
// -----------------------------------------------------------------------------
async function startDesktopBroadcast() {
  initAudioMasterBus();
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  try {
    desktopRawStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { max: 1280 },
        height: { max: 720 },
        frameRate: { max: 15 }
      },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
        sampleRate: 48000,
        sampleSize: 16
      }
    });

    const audioTracks = desktopRawStream.getAudioTracks();
    if (!audioTracks || audioTracks.length === 0) {
      desktopRawStream.getTracks().forEach(t => t.stop());
      alert('Cruzo Alert: No audio track detected!\n\nPlease check the "Also share system audio" toggle at the bottom of the Chrome prompt.');
      return;
    }

    // Stop video track so only audio is transmitted
    desktopRawStream.getVideoTracks().forEach(t => t.stop());

    // Connect to Master Web Audio Bus for spectrum analyser
    if (desktopSourceNode) {
      desktopSourceNode.disconnect();
    }
    desktopSourceNode = audioContext.createMediaStreamSource(desktopRawStream);
    desktopSourceNode.connect(analyserNode);

    // Swap the active audio track on all connected peers to the raw hardware audio track
    const newTrack = audioTracks[0];
    for (const [id, pc] of peerConnections.entries()) {
      const senders = pc.getSenders();
      const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
      if (audioSender) {
        audioSender.replaceTrack(newTrack).catch(e => console.warn('replaceTrack error:', e));
      } else {
        pc.addTrack(newTrack, broadcastStream);
      }
    }

    audioTracks[0].onended = () => {
      stopDesktopBroadcast();
    };

    startVisualizerLoop();
    updateHostStatus('BROADCASTING (DESKTOP)', true);
    btnStartBroadcast.disabled = true;
    btnStopBroadcast.disabled = false;
  } catch (err) {
    console.error('[Cruzo] getDisplayMedia error:', err);
    if (err.name !== 'NotAllowedError') {
      alert(`Audio capture failed: ${err.message}`);
    }
  }
}

function stopDesktopBroadcast() {
  if (desktopSourceNode) {
    desktopSourceNode.disconnect();
    desktopSourceNode = null;
  }
  if (desktopRawStream) {
    desktopRawStream.getTracks().forEach(t => t.stop());
    desktopRawStream = null;
  }

  // Swap peers back to master bus track
  const fallbackTrack = broadcastStream.getAudioTracks()[0];
  if (fallbackTrack) {
    for (const pc of peerConnections.values()) {
      const senders = pc.getSenders();
      const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
      if (audioSender) {
        audioSender.replaceTrack(fallbackTrack).catch(() => {});
      }
    }
  }

  updateHostStatus('READY', false);
  btnStartBroadcast.disabled = false;
  btnStopBroadcast.disabled = true;
}

// -----------------------------------------------------------------------------
// 6. Built-in Cinema Player with Real Frame-Delayed Canvas Engine
// -----------------------------------------------------------------------------
function setupCinemaPlayer() {
  cinemaCanvasCtx = cinemaDisplayCanvas.getContext('2d', { alpha: false });

  cinemaDropzone.addEventListener('click', () => cinemaFileInput.click());

  cinemaDropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    cinemaDropzone.classList.add('dragover');
  });

  cinemaDropzone.addEventListener('dragleave', () => {
    cinemaDropzone.classList.remove('dragover');
  });

  cinemaDropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    cinemaDropzone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      loadCinemaFile(e.dataTransfer.files[0]);
    }
  });

  cinemaFileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) {
      loadCinemaFile(e.target.files[0]);
    }
  });

  cinemaDelaySlider.addEventListener('input', (e) => {
    cinemaVideoDelayMs = parseInt(e.target.value, 10);
    cinemaDelayValue.textContent = `${cinemaVideoDelayMs} ms`;
  });

  btnCinemaPlayPause.addEventListener('click', () => {
    if (localCinemaVideo.paused) {
      localCinemaVideo.play();
    } else {
      localCinemaVideo.pause();
    }
  });

  localCinemaVideo.addEventListener('play', () => {
    cinemaPlayIcon.innerHTML = `<rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect>`;
    renderCinemaLoop();
  });

  localCinemaVideo.addEventListener('pause', () => {
    cinemaPlayIcon.innerHTML = `<polygon points="5 3 19 12 5 21 5 3"></polygon>`;
  });

  localCinemaVideo.addEventListener('timeupdate', () => {
    if (!isScrubbing && localCinemaVideo.duration) {
      cinemaSeekBar.value = (localCinemaVideo.currentTime / localCinemaVideo.duration) * 100;
      cinemaTimeDisplay.textContent = `${formatTime(localCinemaVideo.currentTime)} / ${formatTime(localCinemaVideo.duration)}`;
    }
  });

  cinemaSeekBar.addEventListener('mousedown', () => { isScrubbing = true; });
  cinemaSeekBar.addEventListener('touchstart', () => { isScrubbing = true; });

  cinemaSeekBar.addEventListener('input', () => {
    if (localCinemaVideo.duration) {
      const targetTime = (cinemaSeekBar.value / 100) * localCinemaVideo.duration;
      cinemaTimeDisplay.textContent = `${formatTime(targetTime)} / ${formatTime(localCinemaVideo.duration)}`;
    }
  });

  cinemaSeekBar.addEventListener('change', () => {
    if (localCinemaVideo.duration) {
      localCinemaVideo.currentTime = (cinemaSeekBar.value / 100) * localCinemaVideo.duration;
      purgeCinemaFrameQueue();
    }
    isScrubbing = false;
  });

  btnCinemaFullscreen.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      cinemaPlayerWrapper.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  });
}

function loadCinemaFile(file) {
  initAudioMasterBus();
  if (audioContext.state === 'suspended') {
    audioContext.resume();
  }

  const fileUrl = URL.createObjectURL(file);
  localCinemaVideo.src = fileUrl;
  cinemaDropzone.style.display = 'none';
  cinemaPlayerWrapper.style.display = 'block';

  localCinemaVideo.onloadedmetadata = () => {
    cinemaDisplayCanvas.width = localCinemaVideo.videoWidth || 1280;
    cinemaDisplayCanvas.height = localCinemaVideo.videoHeight || 720;
    cinemaTimeDisplay.textContent = `00:00 / ${formatTime(localCinemaVideo.duration)}`;

    if (!cinemaAudioSource) {
      cinemaAudioSource = audioContext.createMediaElementSource(localCinemaVideo);
      cinemaAudioSource.connect(masterDest);
      cinemaAudioSource.connect(analyserNode);
      cinemaAudioSource.connect(audioContext.destination);
    }

    startVisualizerLoop();
    updateHostStatus('BROADCASTING (CINEMA)', true);
    localCinemaVideo.play().catch(e => console.log('Autoplay deferred:', e));
  };
}

function renderCinemaLoop() {
  if (localCinemaVideo.paused || localCinemaVideo.ended) return;

  const now = performance.now();

  if (cinemaVideoDelayMs <= 0) {
    if (localCinemaVideo.videoWidth) {
      cinemaCanvasCtx.drawImage(localCinemaVideo, 0, 0, cinemaDisplayCanvas.width, cinemaDisplayCanvas.height);
    }
  } else {
    if (localCinemaVideo.videoWidth && localCinemaVideo.readyState >= 2) {
      createImageBitmap(localCinemaVideo).then(bitmap => {
        cinemaFrameQueue.push({
          bitmap,
          targetTime: performance.now() + cinemaVideoDelayMs
        });
      }).catch(() => {});
    }

    let frameToDraw = null;
    while (cinemaFrameQueue.length > 0 && cinemaFrameQueue[0].targetTime <= now) {
      if (frameToDraw) {
        frameToDraw.bitmap.close();
      }
      frameToDraw = cinemaFrameQueue.shift();
    }

    if (frameToDraw) {
      cinemaCanvasCtx.drawImage(frameToDraw.bitmap, 0, 0, cinemaDisplayCanvas.width, cinemaDisplayCanvas.height);
      frameToDraw.bitmap.close();
    }
  }

  if ('requestVideoFrameCallback' in localCinemaVideo) {
    localCinemaVideo.requestVideoFrameCallback(renderCinemaLoop);
  } else {
    cinemaDelayRafId = requestAnimationFrame(renderCinemaLoop);
  }
}

function purgeCinemaFrameQueue() {
  cinemaFrameQueue.forEach(f => {
    try { f.bitmap.close(); } catch (e) {}
  });
  cinemaFrameQueue = [];
}

// -----------------------------------------------------------------------------
// 7. Audio Test Chime & Sync Clapper Matrix
// -----------------------------------------------------------------------------
function playAudioTestChime() {
  initAudioMasterBus();
  if (audioContext.state === 'suspended') {
    audioContext.resume();
  }

  const notes = [523.25, 659.25, 783.99];
  const now = audioContext.currentTime;

  notes.forEach((freq, index) => {
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, now + index * 0.18);

    gain.gain.setValueAtTime(0.001, now + index * 0.18);
    gain.gain.exponentialRampToValueAtTime(0.7, now + index * 0.18 + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.001, now + index * 0.18 + 0.35);

    osc.connect(gain);
    gain.connect(masterDest);
    gain.connect(analyserNode);
    gain.connect(audioContext.destination);

    osc.start(now + index * 0.18);
    osc.stop(now + index * 0.18 + 0.36);
  });

  startVisualizerLoop();

  btnPlayTestChime.textContent = '🎶 Playing Chime...';
  setTimeout(() => {
    btnPlayTestChime.textContent = '🔊 Play Test Sound';
  }, 900);
}

function toggleClapperTest() {
  if (isClapperRunning) {
    stopClapperTest();
  } else {
    startClapperTest();
  }
}

function startClapperTest() {
  initAudioMasterBus();
  if (audioContext.state === 'suspended') {
    audioContext.resume();
  }

  isClapperRunning = true;
  btnToggleClapper.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12"></rect></svg> Stop Sync Clapper`;
  btnToggleClapper.classList.remove('btn-secondary');
  btnToggleClapper.classList.add('btn-danger');

  triggerClapperPulse();
  clapperInterval = setInterval(triggerClapperPulse, 2000);
}

function triggerClapperPulse() {
  clapperFlashBox.classList.add('flash');
  clapperFlashBox.textContent = '⚡ FLASH & BIP!';
  setTimeout(() => {
    clapperFlashBox.classList.remove('flash');
    clapperFlashBox.textContent = 'SYNC CLAPPER (RUNNING)';
  }, 100);

  if (audioContext && audioContext.state !== 'closed') {
    try {
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(1000, audioContext.currentTime);

      gain.gain.setValueAtTime(0.7, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.08);

      osc.connect(gain);
      gain.connect(masterDest);
      gain.connect(analyserNode);
      gain.connect(audioContext.destination);

      osc.start();
      osc.stop(audioContext.currentTime + 0.08);
    } catch (e) {
      console.error('[Cruzo] Clapper audio error:', e);
    }
  }
}

function stopClapperTest() {
  isClapperRunning = false;
  if (clapperInterval) {
    clearInterval(clapperInterval);
    clapperInterval = null;
  }
  btnToggleClapper.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg> Start Sync Clapper`;
  btnToggleClapper.classList.remove('btn-danger');
  btnToggleClapper.classList.add('btn-secondary');
  clapperFlashBox.classList.remove('flash');
  clapperFlashBox.textContent = 'SYNC CLAPPER (OFF)';
}

// -----------------------------------------------------------------------------
// 8. Audio Visualizer Spectrum
// -----------------------------------------------------------------------------
function setupCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = (rect.width || 600) * dpr;
  canvas.height = (rect.height || 90) * dpr;
}

function startVisualizerLoop() {
  if (!analyserNode || visualizerAnimationId) return;

  const canvas = hostVisualizerCanvas;
  const ctx = canvas.getContext('2d');
  const bufferLength = analyserNode.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  function render() {
    visualizerAnimationId = requestAnimationFrame(render);
    analyserNode.getByteFrequencyData(dataArray);

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const barWidth = (canvas.width / bufferLength) * 2.2;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      const barHeight = (dataArray[i] / 255) * canvas.height;

      const gradient = ctx.createLinearGradient(0, canvas.height, 0, 0);
      gradient.addColorStop(0, '#0284c7');
      gradient.addColorStop(0.5, '#10b981');
      gradient.addColorStop(1, '#34d399');

      ctx.fillStyle = gradient;
      ctx.fillRect(x, canvas.height - barHeight, barWidth - 1, barHeight);

      x += barWidth;
    }
  }

  render();
}

// -----------------------------------------------------------------------------
// 9. Connected Devices UI & Telemetry Management
// -----------------------------------------------------------------------------
function addPeerToUI(watcherInfo) {
  noPeersNotice.style.display = 'none';
  peersList.style.display = 'flex';

  const existing = document.getElementById(`peer-${watcherInfo.id}`);
  if (existing) return;

  const isIOS = /iPhone|iPad|iPod/i.test(watcherInfo.userAgent);
  const isAndroid = /Android/i.test(watcherInfo.userAgent);
  const deviceType = isIOS ? 'Apple iOS' : isAndroid ? 'Android' : 'Mobile / PC';

  const card = document.createElement('div');
  card.id = `peer-${watcherInfo.id}`;
  card.className = 'peer-row';
  card.setAttribute('data-watcher-id', watcherInfo.id);

  card.innerHTML = `
    <div class="peer-info">
      <div class="peer-icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect><line x1="12" y1="18" x2="12.01" y2="18"></line></svg>
      </div>
      <div class="peer-details">
        <span class="peer-name">${escapeHtml(watcherInfo.deviceName)}</span>
        <span class="peer-meta">${deviceType} • IP: ${watcherInfo.ip}</span>
      </div>
    </div>
    <div class="peer-telemetry">
      <span class="telemetry-pill good" id="ping-${watcherInfo.id}">Ping: -- ms</span>
      <span class="telemetry-pill" id="sync-${watcherInfo.id}">Sync: 0ms</span>
      <span class="status-badge" id="state-${watcherInfo.id}" style="font-size: 0.65rem;">INIT</span>
      <button class="btn-icon text-rose" title="Kick Device" onclick="kickWatcher('${watcherInfo.id}')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
    </div>
  `;

  peersList.appendChild(card);
  updateConnectedCount();
}

function removePeer(watcherId) {
  if (peerConnections.has(watcherId)) {
    try {
      peerConnections.get(watcherId).close();
    } catch (e) {}
    peerConnections.delete(watcherId);
  }
  pendingIceCandidatesMap.delete(watcherId);

  const el = document.getElementById(`peer-${watcherId}`);
  if (el) el.remove();

  updateConnectedCount();
}

function updatePeerTelemetry(watcherId, rtt, delayOffset) {
  const pingEl = document.getElementById(`ping-${watcherId}`);
  if (pingEl && rtt !== undefined) {
    pingEl.textContent = `${rtt} ms`;
    pingEl.className = `telemetry-pill ${rtt < 25 ? 'good' : rtt < 60 ? 'warn' : ''}`;
  }

  const syncEl = document.getElementById(`sync-${watcherId}`);
  if (syncEl && delayOffset !== undefined) {
    syncEl.textContent = `Sync: +${delayOffset}ms`;
  }
}

function updatePeerStateBadge(watcherId, state) {
  const badge = document.getElementById(`state-${watcherId}`);
  if (!badge) return;

  const normalized = (state || '').toLowerCase();
  badge.textContent = normalized.toUpperCase();

  if (normalized === 'connected' || normalized === 'completed') {
    badge.className = 'status-badge live';
    badge.style.fontSize = '0.65rem';
  } else if (normalized === 'checking') {
    badge.className = 'status-badge text-amber';
    badge.style.fontSize = '0.65rem';
  } else if (normalized === 'failed' || normalized === 'disconnected') {
    badge.className = 'status-badge text-rose';
    badge.style.fontSize = '0.65rem';
  } else {
    badge.className = 'status-badge';
    badge.style.fontSize = '0.65rem';
  }
}

function updateConnectedCount() {
  const count = document.querySelectorAll('.peer-row').length;
  connectedCount.textContent = count;
  if (count === 0) {
    noPeersNotice.style.display = 'block';
    peersList.style.display = 'none';
  }
}

window.kickWatcher = function(watcherId) {
  if (confirm('Disconnect this listener?')) {
    socket.emit('kick-watcher', { watcherId });
    removePeer(watcherId);
  }
};

// -----------------------------------------------------------------------------
// 10. UI Status Helpers & Event Listeners
// -----------------------------------------------------------------------------
function updateHostStatus(text, isLive) {
  hostStatusText.textContent = text;
  if (isLive) {
    hostStatusBadge.className = 'status-badge live';
  } else {
    hostStatusBadge.className = 'status-badge';
  }
}

function setupUIEventListeners() {
  btnStartBroadcast.addEventListener('click', startDesktopBroadcast);
  btnStopBroadcast.addEventListener('click', stopDesktopBroadcast);
  btnPlayTestChime.addEventListener('click', playAudioTestChime);
  btnToggleClapper.addEventListener('click', toggleClapperTest);

  // Tab switching
  tabDesktopBtn.addEventListener('click', () => {
    tabDesktopBtn.classList.add('active');
    tabCinemaBtn.classList.remove('active');
    panelDesktop.style.display = 'block';
    panelCinema.style.display = 'none';
  });

  tabCinemaBtn.addEventListener('click', () => {
    tabCinemaBtn.classList.add('active');
    tabDesktopBtn.classList.remove('active');
    panelDesktop.style.display = 'none';
    panelCinema.style.display = 'block';
  });

  // Copy URL Button
  btnCopyUrl.addEventListener('click', () => {
    const url = listenUrlDisplay.textContent;
    navigator.clipboard.writeText(url).then(() => {
      btnCopyUrl.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
      setTimeout(() => {
        btnCopyUrl.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
      }, 1500);
    });
  });

  setupCinemaPlayer();
}

function formatTime(seconds) {
  if (isNaN(seconds) || seconds === Infinity) return '00:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const hrs = Math.floor(mins / 60);
  const displayMins = mins % 60;

  if (hrs > 0) {
    return `${hrs.toString().padStart(2, '0')}:${displayMins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${displayMins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[s]));
}
