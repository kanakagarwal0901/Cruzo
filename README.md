# 🎧 Cruzo — Multi-Device Local Wireless Audio Matrix

> **One Screen. Five Friends. Zero Tangled Wires. Zero Internet Data.**  
> Turn any smartphone into a low-latency wireless audio receiver for a single Host PC over Local Wi-Fi (LAN) using WebRTC UDP streaming.

---

## 📖 Table of Contents
1. [The Problem Statement](#-1-the-problem-statement)
2. [How Cruzo Solves It](#-2-how-cruzo-solves-it)
3. [Architectural Analysis & Tech Comparison](#-3-architectural-analysis--tech-comparison)
4. [System Architecture & Data Flow](#-4-system-architecture--data-flow)
5. [Solving the "Lip-Sync & Bluetooth Lag" Boss](#-5-solving-the-lip-sync--bluetooth-lag-boss)
6. [Crucial Technical Gotchas & Bypasses](#-6-crucial-technical-gotchas--bypasses)
7. [Step-by-Step Implementation Roadmap](#-7-step-by-step-implementation-roadmap)
8. [Project Directory Structure](#-8-project-directory-structure)
9. [Quick Start & Local Setup](#-9-quick-start--local-setup)
10. [Usage & Calibration Guide](#-10-usage--calibration-guide)
11. [Benchmarking & Alternatives](#-11-benchmarking--alternatives)

---

## 🎯 1. The Problem Statement

Imagine a group of 5 friends wanting to watch a movie together on a single laptop/PC in a hostel room, dorm, or living room. Everyone wants to wear their own personal wireless earbuds or headphones for immersive audio without disturbing others.

**The Hardware Limitation:**  
Standard Bluetooth network cards on Windows/Linux/macOS laptops only support **one active A2DP (Advanced Audio Distribution Profile) stereo stream at a time**. Because of this, you cannot natively pair and stream audio to 5 pairs of Bluetooth earbuds simultaneously from one PC.

---

## 💡 2. How Cruzo Solves It

Instead of fighting the Host PC's Bluetooth hardware ceiling, **Cruzo** routes the PC's audio over a **Local Area Network (Wi-Fi / Mobile Hotspot)** directly to mobile browsers using **WebRTC (UDP)**.

1. **The Host PC** plays the movie and hosts a lightweight local web server (`Cruzo Host`).
2. **The Listeners (5 Friends)** connect their personal Bluetooth earbuds to their own **smartphones**.
3. **Instant Pairing:** Each friend scans a QR code displayed on the Host PC, opens the Cruzo mobile web app in their browser, and joins the local audio room.
4. **Zero Internet Bandwidth:** Because WebRTC negotiates peer connections over the local subnet (`192.168.x.x`), audio packets travel directly from the laptop's Wi-Fi card to the phones via the router/hotspot without consuming a single megabyte of internet data.

---

## ⚖️ 3. Architectural Analysis & Tech Comparison

| Architecture Approach | End-to-End Network Latency | Audio Quality | Setup Friction | Lip-Sync Viability |
| :--- | :--- | :--- | :--- | :--- |
| **1. Pure WebRTC (P2P / Star Mesh)** *(Selected for Cruzo)* | **20ms – 60ms** (Network) + Bluetooth delay | High (Opus Codec, 48kHz Stereo, 256kbps) | **Zero** (Just open local URL / scan QR) | **High** (Best for cross-platform web apps) |
| **2. WebSockets + Web Audio API (Raw PCM)** | **80ms – 200ms** (TCP head-of-line blocking) | Uncompressed PCM or Opus | **Zero** (Browser-based) | **Medium** (Prone to buffer drift over 2-hour movies) |
| **3. Native WASAPI Server (C++/Python + UDP)** | **10ms – 30ms** | Lossless / Custom | **High** (Requires installing native client apps) | **Highest** (Used by native tools like *AudioRelay*) |

### Why Cruzo Uses Approach #1 (Local WebRTC Star Topology)
WebRTC transports media over **UDP (User Datagram Protocol)**. In a 2-hour movie, if a single Wi-Fi packet drops due to interference, TCP-based solutions (like WebSockets or HTTP chunked streaming) pause the stream to request the missing packet—causing audio lag to snowball over time. WebRTC simply skips the dropped millisecond and keeps the audio locked in real time.

---

## 🏗️ 4. System Architecture & Data Flow

```text
[Host PC: Movie Playing on Screen] 
       │
       ├── 1. Captures System/Tab Audio via navigator.mediaDevices.getDisplayMedia()
       ├── 2. Disables Voice Filters (echoCancellation: false, noiseSuppression: false)
       ├── 3. Forces Stereo 256kbps Opus via SDP Manipulation
       │
       ▼ (Local Wi-Fi / Mobile Hotspot — 100% Offline LAN Traffic)
 ┌─────────────────────────────────────────────────────────────────┐
 │  Cruzo Node.js + Socket.io Signaling Server (Running on Host PC)│
 └─────────────────────────────────────────────────────────────────┘
       │                   │                   │                   │
   (WebRTC UDP)        (WebRTC UDP)        (WebRTC UDP)        (WebRTC UDP)
       ▼                   ▼                   ▼                   ▼
  [Smartphone 1]      [Smartphone 2]      [Smartphone 3]      [Smartphone 4]
  (20ms Buffer)       (20ms Buffer)       (20ms Buffer)       (20ms Buffer)
       │                   │                   │                   │
  (Bluetooth)         (Bluetooth)         (Bluetooth)         (Bluetooth)
       ▼                   ▼                   ▼                   ▼
  [Earbuds 1]         [Earbuds 2]         [Earbuds 3]         [Earbuds 4]
```

* **Bandwidth Footprint:** Streaming high-bitrate stereo Opus audio (~256 kbps per peer) to 5 smartphones simultaneously requires only **~1.3 Mbps of local Wi-Fi throughput**, which any standard router or mobile hotspot handles effortlessly.

---

## ⏱️ 5. Solving the "Lip-Sync & Bluetooth Lag" Boss

1. **Host-Side Visual Delay (Compensation for All Bluetooth Users):**
   * **Built-in Cruzo Web Player:** If playing a local `.mp4`/`.mkv` inside the Cruzo Host web dashboard, a **Visual Delay Slider** offsets the `<video>` element relative to the captured audio track.
   * **External Media Players (VLC / MPV):** If watching on VLC Media Player, the host presses `J` or `K` on the keyboard to shift the audio track by `-150ms` to `-200ms`, aligning the actors' lips on the laptop screen with everyone's Bluetooth earbuds.

2. **Client-Side Per-Device Micro-Calibration (`DelayNode`):**
   Each mobile client passes its incoming WebRTC audio stream through a Web Audio API `DelayNode`, giving every user a personal **0ms to +400ms Audio Sync Slider** on their phone screen with preset buttons for Wired, AirPods, Standard Bluetooth, and High-Latency earphones.

3. **Sync Clapper Pulse (Bip & Flash Calibration):**
   Cruzo includes a built-in sync clapper tool that flashes the screen and sends a synchronized audio beep every 2 seconds, allowing everyone in the room to dial in their personal millisecond delay instantly.

---

## 🛡️ 6. Crucial Technical Gotchas & Bypasses

1. **The "Underwater Movie Audio" Trap (DSP Voice Filters):**
   * Cruzo disables `echoCancellation`, `noiseSuppression`, and `autoGainControl` during audio capture, and mutates the WebRTC **Session Description Protocol (SDP)** payload to force **48kHz Stereo Opus at 256kbps Constant Bitrate (CBR)**.
2. **Chrome's HTTPS Restriction on `getDisplayMedia()`:**
   * The Host opens the broadcaster dashboard strictly via `http://localhost:3000/host` (which Chrome treats as a secure context), while mobile listeners connect via `http://192.168.x.x:3000/listen` (receiving WebRTC audio does not require `getDisplayMedia`, so plain HTTP works seamlessly without SSL certificate warnings).
3. **Mobile Browser Autoplay Policies:**
   * The mobile UI features a prominent **"Tap to Connect & Unmute"** button that initializes both the `AudioContext` and `.play()` inside a single click handler.
4. **Phone Screen-Lock Background Kill-Switch:**
   * Cruzo pipes the WebRTC stream through an HTML5 `<audio>` element registered with the **Navigator MediaSession API** alongside a continuous silent loop audio element and the **Screen Wake Lock API** (`navigator.wakeLock.request('screen')`).

---

## 📂 8. Project Directory Structure

```text
cruzo/
├── package.json              # Node dependencies (express, socket.io, qrcode)
├── server.js                 # Express HTTP server, LAN IP detector & Socket.io signaling
├── public/
│   ├── css/
│   │   └── style.css         # Obsidian Dark UI with Emerald/Sapphire accents
│   ├── js/
│   │   ├── host.js           # Host WebRTC broadcaster, SDP stereo hack & telemetry
│   │   └── listen.js         # Mobile WebRTC receiver, playoutDelayHint & DelayNode
│   ├── assets/
│   │   └── silent.mp3        # 1-second loop for iOS/Android MediaSession keep-alive
│   ├── host.html             # Host PC Dashboard (Run on http://localhost:3000/host)
│   └── listen.html           # Mobile Receiver App (Opened via QR code on phones)
└── README.md                 # Project Documentation & Architecture Blueprint
```

---

## 🚀 9. Quick Start & Local Setup

### 1. Start the Server
```bash
node server.js
```

### 2. Launch Host Dashboard
On the Host PC, open Chrome, Edge, or Brave:
```text
http://localhost:3000/host
```
Click **"Start Audio Broadcast"**, select your movie player window or tab, and make sure **"Also share system audio"** is checked.

### 3. Connect Smartphones
* Connect smartphones and Host PC to the same Wi-Fi router or mobile hotspot.
* Friends scan the **QR Code** on the Host screen with their smartphone camera (or browse to `http://<HOST_IP>:3000/listen`).
* Tap **"Tap to Unmute Audio"** on each phone to start receiving high-fidelity stereo audio!

---

## 📜 License
Distributed under the MIT License.
