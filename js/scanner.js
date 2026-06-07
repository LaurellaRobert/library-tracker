/**
 * Barcode scanner module using html5-qrcode.
 * Handles camera lifecycle and ISBN detection.
 */

const Scanner = (() => {
  let html5Qr = null;
  let isRunning = false;
  let onDetect = null;

  /**
   * Start the camera scanner.
   * @param {string} elementId - DOM id of the container div
   * @param {function} callback - called with the decoded ISBN string
   */
  async function start(elementId, callback) {
    if (isRunning) return;
    onDetect = callback;

    html5Qr = new Html5Qrcode(elementId);

    const config = {
      fps: 15,
      qrbox: (viewfinderWidth, viewfinderHeight) => {
        const w = Math.min(Math.floor(viewfinderWidth * 0.9), 400);
        // Keep height proportional to width like a real barcode (~2.5:1), don't cap too low
        const h = Math.max(Math.min(Math.floor(w / 2.5), Math.floor(viewfinderHeight * 0.55)), 80);
        return { width: w, height: h };
      },
      formatsToSupport: [
        Html5QrcodeSupportedFormats.EAN_13,
        Html5QrcodeSupportedFormats.EAN_8,
        Html5QrcodeSupportedFormats.UPC_A,
        Html5QrcodeSupportedFormats.UPC_E
      ],
    };

    try {
      await html5Qr.start(
        { facingMode: 'environment' },
        config,
        handleSuccess,
        () => {} // ignore per-frame failures (no barcode in frame yet)
      );
      isRunning = true;
    } catch (err) {
      console.error('Scanner start error:', err);
      throw err;
    }
  }

  function handleSuccess(decodedText) {
    // Basic ISBN/EAN validation: 10 or 13 digits
    const cleaned = decodedText.replace(/[^0-9Xx]/g, '');
    if (cleaned.length === 13 || cleaned.length === 10) {
      // Pause scanning to avoid duplicate reads
      if (html5Qr) html5Qr.pause(true);
      if (onDetect) onDetect(cleaned);
    }
  }

  /**
   * Resume scanning after a pause (e.g. user goes back from confirm screen).
   */
  function resume() {
    if (html5Qr && isRunning) {
      try { html5Qr.resume(); } catch (_) { /* ignore if already running */ }
    }
  }

  /**
   * Stop the camera and release resources.
   */
  async function stop() {
    if (html5Qr && isRunning) {
      try { await html5Qr.stop(); } catch (_) {}
      isRunning = false;
    }
  }

  return { start, stop, resume };
})();
