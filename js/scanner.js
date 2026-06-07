const Scanner = (() => {
  // native BarcodeDetector state
  let nativeVideo    = null;
  let nativeStream   = null;
  let nativeDetector = null;
  let rafId          = null;
  let nativePaused   = false;

  // Quagga2 fallback state
  let quaggaRunning = false;

  // html5-qrcode last-resort state
  let html5Qr = null;

  let isRunning = false;
  let onDetect  = null;

  async function start(elementId, callback) {
    if (isRunning) return;
    onDetect = callback;

    if ('BarcodeDetector' in window) {
      await startNative(elementId);
    } else if (typeof Quagga !== 'undefined') {
      await startQuagga(elementId);
    } else {
      await startLegacy(elementId);
    }
    isRunning = true;
  }

  /* ---------- Native BarcodeDetector (Chrome/Edge on Android & desktop) ---------- */

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

  /* ---------- Quagga2 fallback (iOS Chrome, iOS Safari, Firefox, older browsers) ---------- */

  function startQuagga(elementId) {
    return new Promise((resolve, reject) => {
      Quagga.init({
        inputStream: {
          type: 'LiveStream',
          target: document.getElementById(elementId),
          constraints: {
            facingMode: 'environment',
            width:  { ideal: 1280 },
            height: { ideal: 720  },
          },
        },
        decoder: {
          readers: ['ean_reader', 'ean_8_reader', 'upc_reader', 'upc_e_reader'],
          multiple: false,
        },
        locate: true,
      }, (err) => {
        if (err) { reject(err); return; }
        Quagga.start();
        quaggaRunning = true;
        resolve();
      });

      Quagga.onDetected((result) => {
        if (!isRunning) return;
        const raw     = result?.codeResult?.code ?? '';
        const cleaned = raw.replace(/[^0-9Xx]/g, '');
        if (cleaned.length === 13 || cleaned.length === 10) {
          Quagga.offDetected();
          Quagga.stop();
          quaggaRunning = false;
          onDetect(cleaned);
        }
      });
    });
  }

  /* ---------- html5-qrcode last resort ---------- */

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
    } else if (typeof Quagga !== 'undefined' && !quaggaRunning) {
      Quagga.onDetected((result) => {
        const raw     = result?.codeResult?.code ?? '';
        const cleaned = raw.replace(/[^0-9Xx]/g, '');
        if (cleaned.length === 13 || cleaned.length === 10) {
          Quagga.offDetected();
          Quagga.stop();
          quaggaRunning = false;
          onDetect(cleaned);
        }
      });
      Quagga.start();
      quaggaRunning = true;
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
    if (quaggaRunning) { try { Quagga.stop(); } catch (_) {} quaggaRunning = false; }
    if (html5Qr) { try { await html5Qr.stop(); } catch (_) {} html5Qr = null; }
  }

  return { start, stop, resume };
})();
