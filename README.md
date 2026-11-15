# Cruzo — Multi-Device Local Wireless Audio

> One screen. Multiple friends. Zero tangled cables. Zero internet data.  
> Turn smartphones into synchronized wireless audio receivers for a single Host PC over local Wi-Fi.

---

## What is Cruzo?

Cruzo is a lightweight local web application that allows multiple people to listen to the same laptop or PC audio using their own phones and Bluetooth earbuds at the same time.

### The Everyday Problem
You and your friends want to watch a movie or show together on one laptop in a room or hostel. Everyone has their own wireless earbuds, but you cannot connect all of them to one computer.

Windows, Mac, and Linux laptops only support **one active Bluetooth audio device at a time**. You cannot pair 4 or 5 pairs of Bluetooth earbuds to a single computer.

### The Cruzo Solution
Instead of connecting all earbuds to the laptop, each friend connects their earbuds to their own smartphone as usual.

The laptop streams its system audio over your local Wi-Fi or mobile hotspot directly to the smartphones using low-latency WebRTC and a direct local audio relay.

- **Zero internet data used:** Audio travels strictly through your local Wi-Fi router or laptop hotspot.
- **No apps to install:** Runs completely in standard web browsers like Chrome, Safari, Edge, and Brave.
- **Works with any earbuds:** Compatible with AirPods, Galaxy Buds, wired headphones, and any other brand.

---

## Core Features

### 1. Minimalist Apple-Inspired Design
- Clean, distraction-free interface built with frosted glass styling and a monochrome color palette (Black, Grey, and White).
- Seamless Dark and Light theme toggle that remembers your preference.
- Interactive frosted glass hover illumination on desktop cards.
- Clean mobile layout with clear text and zero emojis.

### 2. Dual-Path Audio Architecture (WebRTC + LAN Relay)
- **Primary Stream (WebRTC UDP):** Delivers ultra-low latency (under 20ms) 48kHz stereo Opus audio, ideal for real-time movie dialogue and action scenes.
- **Fallback Stream (WebSocket LAN Relay):** On university, corporate, or campus networks where routers block direct peer-to-peer UDP connections (Client Isolation), Cruzo automatically falls back to an uncompressed 48kHz stereo PCM LAN stream. You stay connected without interruption.

### 3. Dynamic IP Detection and Auto-Refreshing QR Code
- Automatically detects the host computer's active Wi-Fi or Ethernet IP address.
- Periodically checks for network changes so if your IP address changes on a campus or shared network, the on-screen QR code and connection link update automatically.
- No need to restart the server when changing Wi-Fi networks.

### 4. In-App QR Scanner
- Mobile users can join by tapping "Join as Listener" and pointing their camera at the Host PC screen.
- Works using modern in-browser barcode detection with an offline decoder fallback.
- If camera permissions are unavailable on plain HTTP, a direct "Join Audio Room" button is provided instantly.

### 5. Bluetooth Lip-Sync Calibration
Because Bluetooth earphones introduce varying amounts of internal hardware delay (usually 100ms to 250ms), Cruzo provides audio timing controls on both host and mobile:
- **Personal Delay Slider:** Adjust your individual sound delay from 0ms up to 400ms.
- **One-Tap Presets:**
  - **Wired (0ms):** For direct headphone jacks or USB-C wired earphones.
  - **Low-Lag (120ms):** For gaming earbuds with low-latency mode enabled.
  - **Earbuds (180ms):** Standard timing for AirPods, Galaxy Buds, and popular wireless earbuds.
  - **Wireless (250ms):** For over-ear Bluetooth headphones with higher processing buffers.
- **Micro Fine-Tuning:** Quick nudge buttons (-20ms, -5ms, +5ms, +20ms) for exact lip-sync alignment.
- **Sync Clapper Tool:** A visual flash and audio beep every 2 seconds on the host console to make syncing simple for the whole group.
- **Audio Test Chime:** A 3-note chime to verify sound delivery across all connected devices before starting your movie.

### 6. Background Audio Playback and Screen Keep-Alive
- **Screen Wake Lock:** Prevents mobile screens from sleeping while audio is playing.
- **Silent Audio Keep-Alive:** Uses a background audio loop so Android and iOS keep browser audio active even if you switch apps or lock the screen.
- **Media Session Integration:** Displays playback metadata on mobile lock screens.

### 7. Automatic Return on Disconnect
- If the host stops broadcasting, closes their browser, or if the connection drops, mobile listener devices automatically display a clean frosted glass notice and return to the home gateway.

### 8. Built-In "How to Use" Guide
- An interactive guide accessible from the top navigation bar with simple 4-step instructions and practical tips for movie players like VLC.

---

## How It Works

```text
[Host PC: Movie / Media Playing]
       │
       ├── 1. Captures system audio via browser screen-share prompt
       ├── 2. Encodes 48kHz stereo Opus / 16-bit PCM
       │
       ▼ (Local Wi-Fi or Laptop Mobile Hotspot — 0 MB Internet Data)
 ┌─────────────────────────────────────────────────────────────┐
 │    Cruzo Signaling Server (Node.js on Host PC)             │
 └─────────────────────────────────────────────────────────────┘
       │                        │                        │
  (Local LAN)              (Local LAN)              (Local LAN)
       │                        │                        │
       ▼                        ▼                        ▼
 [Friend 1 Phone]         [Friend 2 Phone]         [Friend 3 Phone]
   (DelayNode)              (DelayNode)              (DelayNode)
       │                        │                        │
  (Bluetooth)              (Bluetooth)              (Bluetooth)
       │                        │                        │
       ▼                        ▼                        ▼
  [Earbuds 1]              [Earbuds 2]              [Earbuds 3]
```

1. **Host PC:** Plays the movie and captures desktop system audio using the browser.
2. **Local Router or Hotspot:** Forwards local network packets directly between devices on the same Wi-Fi. No data leaves your room or travels through the internet.
3. **Smartphones:** Receive the audio stream and route it to each user's personal Bluetooth earphones with individual delay adjustments.

---

## Quick Start Guide

### Requirements
- A laptop or desktop PC (Windows, macOS, or Linux).
- Node.js installed (v16 or newer recommended).
- Smartphones with any modern web browser (Chrome, Safari, Edge, Firefox).
- All devices connected to the **same Wi-Fi network** or a **laptop mobile hotspot**.

### Step 1: Install Dependencies
Open a terminal in the project directory and install packages:
```bash
npm install
```

### Step 2: Start the Server
```bash
node server.js
```
The terminal will display the local addresses:
```text
Gateway Home:      http://localhost:3000/
Host PC Console:   http://localhost:3000/host
Mobile Listener:   http://<YOUR_LAN_IP>:3000/listen
```

### Step 3: Start Host Broadcast (Laptop)
1. Open Chrome, Edge, or Brave on your PC and visit:
   ```text
   http://localhost:3000/host
   ```
2. Click **Start Audio Broadcast**.
3. In the browser popup, choose **Entire Screen** (or the tab/window playing your movie) and make sure **"Also share system audio"** is checked at the bottom.
4. Your Host Console will show a green **BROADCASTING** status and the live audio waveform.

### Step 4: Connect Listener Phones
1. Make sure your friends' phones are on the same Wi-Fi network as the laptop.
2. Scan the **QR Code** displayed on the host screen using a phone camera or visit the shown URL.
3. On the phone, tap **Connect Audio**.
4. Audio will play through their connected Bluetooth earbuds.

---

## Fine-Tuning Lip-Sync

If the actors' voices feel slightly ahead or behind their lips:

1. **For the Entire Group (Using VLC Media Player):**
   - While playing the video in VLC on the host laptop, press **J** on your keyboard 3 or 4 times.
   - Each press shifts audio forward by -50ms (for a total of -150ms to -200ms), perfectly counteracting standard Bluetooth delay for everyone.
2. **For Individual Listeners:**
   - Tap one of the presets on your phone screen (such as **Earbuds** for 180ms).
   - Use the slider or the fine-tuning buttons (-5ms / +5ms) until the dialogue matches the screen.

---

## Project Structure

```text
cruzo/
├── package.json              # Node dependencies (express, socket.io, qrcode)
├── server.js                 # HTTP server, dynamic LAN IP detection & signaling
├── public/
│   ├── css/
│   │   └── style.css         # Apple frosted glass design system (Dark & Light)
│   ├── js/
│   │   ├── host.js           # Host broadcast engine, audio routing & telemetry
│   │   ├── listen.js         # Mobile receiver, WebRTC playout & LAN relay player
│   │   ├── scanner.js        # In-app QR camera scanner controller
│   │   ├── jsQR.js           # Standalone offline QR code recognition engine
│   │   ├── glass-hover.js    # Frosted glass specular lighting effect on hover
│   │   └── guide.js          # Interactive "How to Use" guide modal controller
│   ├── assets/
│   │   └── silent.mp3        # Keep-alive loop for mobile background playout
│   ├── index.html            # Gateway Home Page (Host vs Join selection)
│   ├── host.html             # Host PC Audio Console
│   └── listen.html           # Minimalist mobile listener deck
└── README.md                 # Complete documentation
```

---

## Troubleshooting

- **Mobile shows "WAITING FOR HOST":**
  Make sure you clicked "Start Audio Broadcast" on the Host PC and selected "Also share system audio".
- **Cannot scan QR code with in-app scanner:**
  Some mobile browsers restrict camera access over plain HTTP. Tap "Join Audio Room Directly" or use your phone's native camera app or Google Lens.
- **No audio after tapping "Connect Audio":**
  Ensure the phone's physical mute switch is turned off (especially on iPhones) and the media volume is turned up.
- **Campus or hostel Wi-Fi connection issues:**
  If your campus Wi-Fi enforces strict device isolation, turn on your laptop's mobile hotspot (Windows: Settings > Network & Internet > Mobile hotspot) and connect all phones directly to your laptop's hotspot.

---

## License
MIT License. Free and open source for personal and community use.
