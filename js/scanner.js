const Scanner = (() => {
  // native BarcodeDetector state
  let nativeVideo   = null;
  let nativeStream  = null;
  let nativeDetector = null;
  let rafId         = null;
  let nativePaused  = false;

  // html5-qrcode fallback state
  let html5Qr = null;

  let isRunning = false;
  let onDetect  = null;

  async function start(elementId, callback) {
    if (isRunning) return;
    onDetect = callback;

    if ('BarcodeDetector' in window) {
      await startNative(elementId);
    } else {
      await startLegacy(elementId);
    }
    isRunning = true;
  }

  /* ---------- Native BarcodeDetector path (Chrome Android, iOS 17+ Safari) ---------- */

  async function startNative(elementId) {
    const supported = await BarcodeDetector.getSupportedFormats();
    const want      = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
    const formats   = want.filter(f => supported.includes(f));
    nativeDetector  = new BarcodeDetector({ formats: formats.length ? formats : ['ean_13'] });

    nativeStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
    });

    nativeVideo = document.createElement('video');
    nativeVideo.playsInline = true;
    nativeVideo.muted       = true;
    nativeVideo.autoplay    = true;
    nativeVideo.srcObject   = nativeStream;
    document.getElementById(elementId).appendChild(nativeVideo);

    await new Promise((resolve) => {
      nativeVideo.addEventListener('loadedmetadata', resolve, { once: true });
    });
    await nativeVideo.play();

    rafId = requestAnimationFrame(tick);
  }

  async function tick() {
    if (!isRunning || nativePaused) return;
    try {
      const results = await nativeDetector.detect(nativeVideo);
      for (const r of results) {
        const cleaned = r.rawValue.replace(/[^0-9Xx]/g, '');
        if (cleaned.length === 13 || cleaned.length === 10) {
          nativePaused = true;
          onDetect(cleaned);
          return;
        }
      }
    } catch (_) {}
    if (isRunning && !nativePaused) rafId = requestAnimationFrame(tick);
  }

  /* ---------- html5-qrcode fallback (older browsers) ---------- */

  async function startLegacy(elementId) {
    html5Qr = new Html5Qrcode(elementId);
    const config = {
      fps: 15,
      qrbox: (w, h) => {
        const qw = Math.min(Math.floor(w * 0.9), 400);
        const qh = Math.max(Math.min(Math.floor(qw / 2.5), Math.floor(h * 0.55)), 80);
        return { width: qw, height: qh };
      },
      formatsToSupport: [
        Html5QrcodeSupportedFormats.EAN_13,
        Html5QrcodeSupportedFormats.EAN_8,
        Html5QrcodeSupportedFormats.UPC_A,
        Html5QrcodeSupportedFormats.UPC_E,
      ],
    };
    await html5Qr.start({ facingMode: 'environment' }, config, handleLegacySuccess, () => {});
  }

  function handleLegacySuccess(decodedText) {
    const cleaned = decodedText.replace(/[^0-9Xx]/g, '');
    if (cleaned.length === 13 || cleaned.length === 10) {
      if (html5Qr) html5Qr.pause(true);
      if (onDetect) onDetect(cleaned);
    }
  }

  /* ---------- Public API ---------- */

  function resume() {
    if (!isRunning) return;
    if (nativeDetector) {
      nativePaused = false;
      rafId = requestAnimationFrame(tick);
    } else if (html5Qr) {
      try { html5Qr.resume(); } catch (_) {}
    }
  }

  async function stop() {
    isRunning = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (nativeStream) { nativeStream.getTracks().forEach(t => t.stop()); nativeStream = null; }
    if (nativeVideo)  { nativeVideo.srcObject = null; nativeVideo.remove(); nativeVideo = null; }
    nativeDetector = null;
    nativePaused   = false;
    if (html5Qr) { try { await html5Qr.stop(); } catch (_) {} html5Qr = null; }
  }

  return { start, stop, resume };
})();
