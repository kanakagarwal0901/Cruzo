/**
 * Cruzo — In-App Mobile QR Scanner Controller
 * Uses native BarcodeDetector API with jsQR offline fallback.
 * Allows mobile users to scan the Host PC screen QR code directly within the web app.
 */

(function () {
  let videoStream = null;
  let isScanning = false;
  let scanRafId = null;
  let offscreenCanvas = null;
  let offscreenCtx = null;
  let hasFoundQr = false;

  // DOM Elements
  let modal = null;
  let video = null;
  let closeBtn = null;
  let directJoinBtn = null;
  let permNotice = null;
  let statusText = null;
  let reticle = null;

  function initScannerElements() {
    modal = document.getElementById('qrScannerModal');
    video = document.getElementById('scannerVideo');
    closeBtn = document.getElementById('scannerCloseBtn');
    directJoinBtn = document.getElementById('scannerDirectJoinBtn');
    permNotice = document.getElementById('scannerPermNotice');
    statusText = document.getElementById('scannerStatusText');
    reticle = document.getElementById('scannerReticle');

    if (!modal) return;

    if (closeBtn) {
      closeBtn.addEventListener('click', closeScanner);
    }

    if (directJoinBtn) {
      directJoinBtn.addEventListener('click', () => {
        closeScanner();
        window.location.href = '/listen';
      });
    }

    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeScanner();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.classList.contains('open')) {
        closeScanner();
      }
    });

    // Intercept "Join as Listener" card clicks on home gateway
    const btnGatewayListen = document.getElementById('btnGatewayListen');
    if (btnGatewayListen) {
      btnGatewayListen.addEventListener('click', (e) => {
        e.preventDefault();
        openScanner();
      });
    }
  }

  async function openScanner() {
    if (!modal) initScannerElements();
    if (!modal) return;

    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
    hasFoundQr = false;

    if (permNotice) permNotice.style.display = 'none';
    if (statusText) statusText.textContent = 'Point camera at the Host PC screen';
    if (reticle) reticle.classList.remove('detected');

    // Initialize offscreen canvas for frame capture
    if (!offscreenCanvas) {
      offscreenCanvas = document.createElement('canvas');
      offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true });
    }

    // Request environment / back camera
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Camera API not supported in this browser');
      }

      videoStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      });

      video.srcObject = videoStream;
      await video.play();

      isScanning = true;
      scanRafId = requestAnimationFrame(scanLoop);
    } catch (err) {
      console.warn('[Cruzo Scanner] Camera access error:', err);
      if (permNotice) {
        permNotice.style.display = 'flex';
      }
      if (statusText) {
        statusText.textContent = 'Camera unavailable. You can join directly:';
      }
    }
  }

  function closeScanner() {
    isScanning = false;
    if (scanRafId) {
      cancelAnimationFrame(scanRafId);
      scanRafId = null;
    }

    if (videoStream) {
      videoStream.getTracks().forEach((track) => track.stop());
      videoStream = null;
    }

    if (video) {
      video.srcObject = null;
    }

    if (modal) {
      modal.classList.remove('open');
    }
    document.body.style.overflow = '';
  }

  async function scanLoop() {
    if (!isScanning || hasFoundQr) return;

    if (video && video.readyState === video.HAVE_ENOUGH_DATA) {
      const width = video.videoWidth;
      const height = video.videoHeight;

      if (width > 0 && height > 0) {
        let detectedRaw = null;

        // 1. Try Native BarcodeDetector (Supported in modern Chrome Android)
        if ('BarcodeDetector' in window) {
          try {
            const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
            const barcodes = await detector.detect(video);
            if (barcodes && barcodes.length > 0 && barcodes[0].rawValue) {
              detectedRaw = barcodes[0].rawValue;
            }
          } catch (_) {
            // Fallback to jsQR below
          }
        }

        // 2. Fallback to offline jsQR engine
        if (!detectedRaw && typeof window.jsQR === 'function') {
          offscreenCanvas.width = width;
          offscreenCanvas.height = height;
          offscreenCtx.drawImage(video, 0, 0, width, height);

          const imageData = offscreenCtx.getImageData(0, 0, width, height);
          const qrCode = window.jsQR(imageData.data, width, height, {
            inversionAttempts: 'dontInvert'
          });

          if (qrCode && qrCode.data) {
            detectedRaw = qrCode.data;
          }
        }

        if (detectedRaw) {
          onQrDetected(detectedRaw);
          return;
        }
      }
    }

    if (isScanning && !hasFoundQr) {
      scanRafId = requestAnimationFrame(scanLoop);
    }
  }

  function onQrDetected(data) {
    hasFoundQr = true;
    isScanning = false;

    console.log('[Cruzo Scanner] QR Code detected:', data);

    if (reticle) {
      reticle.classList.add('detected');
    }

    if (statusText) {
      statusText.textContent = 'Host PC Connected! Joining room...';
    }

    // Play subtle audio click feedback
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.12);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.13);
    } catch (_) {}

    // Navigate to scanned URL
    setTimeout(() => {
      closeScanner();

      // Normalize scanned target
      let targetUrl = data.trim();
      if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
        if (targetUrl.startsWith('/')) {
          targetUrl = window.location.origin + targetUrl;
        } else {
          targetUrl = 'http://' + targetUrl;
        }
      }

      window.location.href = targetUrl;
    }, 450);
  }

  // Export functions globally
  window.CruzoScanner = {
    open: openScanner,
    close: closeScanner
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initScannerElements);
  } else {
    initScannerElements();
  }
})();
