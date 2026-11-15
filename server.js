const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');
const path = require('path');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

// Resolve best local LAN IPv4 address (Physical Wi-Fi / Ethernet)
function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const name of Object.keys(interfaces)) {
    const isVirtual = /vethernet|virtualbox|vmware|wsl|loopback|pseudo|hyper-v/i.test(name);
    for (const iface of interfaces[name]) {
      const isIPv4 = iface.family === 'IPv4' || iface.family === 4;
      const isLinkLocal = iface.address.startsWith('169.254.');
      if (isIPv4 && !iface.internal && !isLinkLocal) {
        const isPrivate = /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(iface.address);
        candidates.push({
          name,
          address: iface.address,
          isVirtual,
          isPrivate
        });
      }
    }
  }

  // 1. Non-virtual private network IP (Physical Wi-Fi / Ethernet)
  const physicalPrivate = candidates.find(c => !c.isVirtual && c.isPrivate);
  if (physicalPrivate) return physicalPrivate.address;

  // 2. Any private network IP
  const anyPrivate = candidates.find(c => c.isPrivate);
  if (anyPrivate) return anyPrivate.address;

  // 3. Any non-internal IP
  if (candidates.length > 0) return candidates[0].address;

  return '127.0.0.1';
}

// Utility: Clean client IPv4 from IPv4-mapped IPv6 (::ffff:192.168.x.x)
function cleanClientIp(rawIp) {
  const currentIp = getLocalIpAddress();
  if (!rawIp) return currentIp;
  if (rawIp.startsWith('::ffff:')) return rawIp.replace('::ffff:', '');
  if (rawIp === '::1') return '127.0.0.1';
  return rawIp;
}

// Utility: De-anonymize mDNS (.local) ICE Candidates to physical IPv4
function deanonymizeCandidate(candidateObj, realIp) {
  if (!candidateObj || !candidateObj.candidate) return candidateObj;
  let str = candidateObj.candidate;

  // Replace any .local mDNS hostname with the real LAN IPv4
  str = str.replace(/([a-zA-Z0-9-]+\.local)/g, realIp);

  // Replace 0.0.0.0 or 127.0.0.1 host candidates with real LAN IPv4
  str = str.replace(/(\b(?:0\.0\.0\.0|127\.0\.0\.1)\b)(?=.*typ host)/g, realIp);

  return {
    ...candidateObj,
    candidate: str
  };
}

// Utility: De-anonymize SDP host candidates & connection addresses
function deanonymizeSdp(sdpStr, realIp) {
  if (!sdpStr || typeof sdpStr !== 'string') return sdpStr;
  let res = sdpStr.replace(/([a-zA-Z0-9-]+\.local)/g, realIp);
  res = res.replace(/(c=IN IP4\s+)(?:0\.0\.0\.0|127\.0\.0\.1)/g, (match, prefix) => prefix + realIp);
  return res;
}

// Serve static frontend assets
app.use(express.static(path.join(__dirname, 'public')));

// Home Gateway Page (Asks whether to Host or Join)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Dedicated routes
app.get('/host', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'host.html'));
});

app.get('/listen', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'listen.html'));
});

// Guide route: Opens Gateway with How-to-Use guide modal active
app.get('/guide', (req, res) => {
  res.redirect('/?guide=1');
});

// API route to provide connection metadata and minimalist QR code (always dynamic IP)
app.get('/api/info', async (req, res) => {
  try {
    const currentIp = getLocalIpAddress();
    const listenUrl = `http://${currentIp}:${PORT}/listen`;
    const hostUrl = `http://localhost:${PORT}/host`;
    const qrCodeDataUrl = await QRCode.toDataURL(listenUrl, {
      errorCorrectionLevel: 'M',
      margin: 1,
      scale: 8,
      color: {
        dark: '#000000',
        light: '#ffffff'
      }
    });

    res.json({
      localIp: currentIp,
      port: PORT,
      listenUrl,
      hostUrl,
      qrCodeDataUrl
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate QR code', details: error.message });
  }
});

// Signaling State
let broadcasterSocketId = null;
let isBroadcastingActive = false;
const connectedWatchers = new Map(); // socketId -> { id, deviceName, ip, userAgent, joinedAt }

io.on('connection', (socket) => {
  const clientIp = cleanClientIp(socket.handshake.address);

  // 1. Broadcaster (Host PC) Registration
  socket.on('broadcaster-register', () => {
    broadcasterSocketId = socket.id;
    const currentIp = getLocalIpAddress();
    console.log(`[Cruzo] Broadcaster registered: ${socket.id} (LAN IP: ${currentIp})`);

    // Send currently connected watchers to broadcaster
    socket.emit('broadcaster-registered', {
      socketId: socket.id,
      watcherCount: connectedWatchers.size,
      watchers: Array.from(connectedWatchers.values())
    });

    // Notify all currently waiting watchers that broadcaster is online
    socket.broadcast.emit('broadcaster-available');
  });

  // Track when broadcaster starts / stops screen/system audio broadcast
  socket.on('broadcaster-started', () => {
    isBroadcastingActive = true;
    console.log('[Cruzo] Broadcaster audio stream active');
    socket.broadcast.emit('broadcaster-started');
  });

  socket.on('broadcaster-stopped', () => {
    isBroadcastingActive = false;
    console.log('[Cruzo] Broadcaster audio stream stopped');
    socket.broadcast.emit('broadcaster-stopped');
  });

  // 2. Watcher (Mobile Client) Registration
  socket.on('watcher-join', (data = {}) => {
    const watcherInfo = {
      id: socket.id,
      deviceName: data.deviceName || 'Smartphone',
      userAgent: data.userAgent || 'Unknown Device',
      ip: clientIp,
      joinedAt: Date.now()
    };
    connectedWatchers.set(socket.id, watcherInfo);
    console.log(`[Cruzo] Watcher joined: ${watcherInfo.deviceName} (${socket.id}) from IP ${clientIp}`);

    // Let the watcher know if broadcaster is active and streaming
    socket.emit('broadcaster-status', {
      active: !!broadcasterSocketId,
      broadcasterId: broadcasterSocketId,
      isBroadcasting: isBroadcastingActive
    });

    // Notify broadcaster that a new watcher has joined
    if (broadcasterSocketId) {
      io.to(broadcasterSocketId).emit('watcher-joined', watcherInfo);
    }
  });

  // 3. WebRTC Offer (Host -> Watcher)
  socket.on('offer', (data) => {
    if (data && data.targetId && data.sdp) {
      const currentIp = getLocalIpAddress();
      const sanitizedSdp = {
        ...data.sdp,
        sdp: deanonymizeSdp(data.sdp.sdp, currentIp)
      };

      io.to(data.targetId).emit('offer', {
        broadcasterId: socket.id,
        sdp: sanitizedSdp
      });
    }
  });

  // 4. WebRTC Answer (Watcher -> Host)
  socket.on('answer', (data) => {
    if (broadcasterSocketId && data && data.sdp) {
      const watcherIp = cleanClientIp(socket.handshake.address);
      const sanitizedSdp = {
        ...data.sdp,
        sdp: deanonymizeSdp(data.sdp.sdp, watcherIp)
      };

      io.to(broadcasterSocketId).emit('answer', {
        watcherId: socket.id,
        sdp: sanitizedSdp
      });
    }
  });

  // 5. ICE Candidate Exchange with mDNS De-Anonymization
  socket.on('ice-candidate', (data) => {
    if (!data || !data.targetId || !data.candidate) return;

    if (socket.id === broadcasterSocketId) {
      const currentIp = getLocalIpAddress();
      const sanitizedCandidate = deanonymizeCandidate(data.candidate, currentIp);
      io.to(data.targetId).emit('ice-candidate', {
        senderId: socket.id,
        candidate: sanitizedCandidate
      });
    } else {
      const watcherIp = cleanClientIp(socket.handshake.address);
      const sanitizedCandidate = deanonymizeCandidate(data.candidate, watcherIp);
      if (broadcasterSocketId) {
        io.to(data.targetId).emit('ice-candidate', {
          senderId: socket.id,
          candidate: sanitizedCandidate
        });
      }
    }
  });

  // 6. Roundtrip Latency Telemetry (Ping/Pong)
  socket.on('telemetry-ping', (data) => {
    socket.emit('telemetry-pong', data);
  });

  socket.on('watcher-telemetry', (data) => {
    if (broadcasterSocketId && data) {
      io.to(broadcasterSocketId).emit('watcher-telemetry-update', {
        watcherId: socket.id,
        rtt: data.rtt,
        delayOffset: data.delayOffset
      });
    }
  });

  // 7. Fallback Audio Stream Relay
  socket.on('stream-audio-chunk', (data) => {
    if (socket.id === broadcasterSocketId) {
      socket.broadcast.emit('audio-chunk', data);
    }
  });

  // 8. Host kicking a watcher
  socket.on('kick-watcher', (data) => {
    if (socket.id === broadcasterSocketId && data && data.watcherId) {
      console.log(`[Cruzo] Host kicked watcher: ${data.watcherId}`);
      io.to(data.watcherId).emit('kicked');
      connectedWatchers.delete(data.watcherId);
    }
  });

  // 9. Disconnect Cleanup
  socket.on('disconnect', () => {
    if (socket.id === broadcasterSocketId) {
      console.log(`[Cruzo] Broadcaster disconnected (${socket.id})`);
      broadcasterSocketId = null;
      isBroadcastingActive = false;
      socket.broadcast.emit('broadcaster-disconnected');
    } else if (connectedWatchers.has(socket.id)) {
      const info = connectedWatchers.get(socket.id);
      console.log(`[Cruzo] Watcher left: ${info.deviceName} (${socket.id})`);
      connectedWatchers.delete(socket.id);
      if (broadcasterSocketId) {
        io.to(broadcasterSocketId).emit('watcher-left', { watcherId: socket.id });
      }
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const currentIp = getLocalIpAddress();
  console.log(`\n======================================================`);
  console.log(` Cruzo — Multi-Device Wireless Audio Matrix `);
  console.log(`======================================================`);
  console.log(` Gateway Home:      http://localhost:${PORT}/`);
  console.log(` Host PC Console:   http://localhost:${PORT}/host`);
  console.log(` Mobile Listener:   http://${currentIp}:${PORT}/listen`);
  console.log(` Local Subnet IP:   ${currentIp}`);
  console.log(`======================================================\n`);
});
