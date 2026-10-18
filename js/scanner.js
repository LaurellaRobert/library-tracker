const Scanner = (() => {
  // The camera only runs while start() is in effect; stop() fully releases it
  // (camera light off). Calls are queued so rapid start/stop toggling always
  // settles on the last requested state, with at most one camera session.
  let wanted   = false;
  let running  = null;            // 'native' | 'quagga' | 'legacy' | null
  let queue    = Promise.resolve();
  let session  = 0;               // bumps each start; stale detection loops exit
  let detected = false;           // ignore further reads until the next start

  let regionId = null;
  let onDetect = null;

  // A blurry or angled frame can decode to the wrong number, so a code only
  // counts once it has been read this many times in a row.
  const CONFIRM_READS  = 3;
  const CONFIRM_WINDOW = 2000; // ms; a stale partial match doesn't carry over
  let candidate      = null;
  let candidateCount = 0;
  let candidateAt    = 0;

  // native BarcodeDetector state
  let nativeVideo    = null;
  let nativeStream   = null;
  let nativeDetector = null;
  let rafId          = null;

  // html5-qrcode last-resort state
  let html5Qr = null;

  function start(elementId, callback) {
    regionId = elementId;
    onDetect = callback;
    wanted   = true;
    return enqueue();
  }

  function stop() {
    wanted = false;
    return enqueue();
  }

  function enqueue() {
    const next = queue.then(sync);
    queue = next.catch(() => {});
    return next;
  }

  async function sync() {
    if (wanted && !running) {
      detected  = false;
      candidate = null;
      session++;
      try {
        if ('BarcodeDetector' in window) {
          await startNative();
        } else if (typeof Quagga !== 'undefined') {
          await startQuagga();
        } else {
          await startLegacy();
        }
      } catch (err) {
        await release();
        wanted = false;
        throw err;
      }
    } else if (!wanted && running) {
      await release();
    }
  }

  // ISBN-13 uses the EAN-13 check digit; ISBN-10 has its own mod-11 check
  function isValidIsbn(isbn) {
    if (/^\d{13}$/.test(isbn)) {
      let sum = 0;
      for (let i = 0; i < 12; i++) sum += Number(isbn[i]) * (i % 2 ? 3 : 1);
      return (10 - (sum % 10)) % 10 === Number(isbn[12]);
    }
    if (/^\d{9}[\dX]$/.test(isbn)) {
      let sum = 0;
      for (let i = 0; i < 10; i++) sum += (isbn[i] === 'X' ? 10 : Number(isbn[i])) * (10 - i);
      return sum % 11 === 0;
    }
    return false;
  }

  // Book barcodes are always EAN-13 starting 978 or 979 ("Bookland")
  const isBookBarcode = (code) => /^97[89]\d{10}$/.test(code) && isValidIsbn(code);

  function report(rawValue) {
    if (detected || !wanted) return false;
    const code = (rawValue || '').replace(/\D/g, '');
    if (!isBookBarcode(code)) return false;

    const now = Date.now();
    if (code === candidate && now - candidateAt < CONFIRM_WINDOW) {
      candidateCount++;
    } else {
      candidate      = code;
      candidateCount = 1;
    }
    candidateAt = now;
    if (candidateCount < CONFIRM_READS) return false;

    detected = true;
    if (navigator.vibrate) navigator.vibrate(60); // haptic "got it" on Android
    onDetect(code);
    return true;
  }

  async function release() {
    session++;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (nativeStream) { nativeStream.getTracks().forEach((t) => t.stop()); nativeStream = null; }
    if (nativeVideo)  { nativeVideo.srcObject = null; nativeVideo.remove(); nativeVideo = null; }
    nativeDetector = null;
    if (running === 'quagga') {
      Quagga.offDetected(handleQuaggaDetected);
      try { await Quagga.stop(); } catch (_) {}
    }
    if (html5Qr) {
      try { await html5Qr.stop(); } catch (_) {}
      try { html5Qr.clear(); } catch (_) {}
      html5Qr = null;
    }
    const region = document.getElementById(regionId);
    if (region) region.innerHTML = '';
    running = null;
  }

  /* ---------- Native BarcodeDetector (Chrome/Edge on Android & desktop) ---------- */

  async function startNative() {
    // Books only use EAN-13; looking for other formats just invites false reads
    nativeDetector = new BarcodeDetector({ formats: ['ean_13'] });

    nativeStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    running = 'native';

    nativeVideo = document.createElement('video');
    nativeVideo.playsInline = true;
    nativeVideo.muted       = true;
    nativeVideo.autoplay    = true;
    nativeVideo.srcObject   = nativeStream;
    document.getElementById(regionId).appendChild(nativeVideo);

    await new Promise((resolve) => {
      nativeVideo.addEventListener('loadedmetadata', resolve, { once: true });
    });
    await nativeVideo.play();

    const mySession = session;
    rafId = requestAnimationFrame(() => tick(mySession));
  }

  async function tick(mySession) {
    if (mySession !== session || detected) return;
    try {
      const results = await nativeDetector.detect(nativeVideo);
      if (mySession !== session) return;
      for (const r of results) {
        if (report(r.rawValue)) return;
      }
    } catch (_) {}
    if (mySession === session && !detected) {
      rafId = requestAnimationFrame(() => tick(mySession));
    }
  }

  /* ---------- Quagga2 fallback (iOS Chrome, iOS Safari, Firefox, older browsers) ---------- */

  function handleQuaggaDetected(result) {
    report(result?.codeResult?.code);
  }

  function startQuagga() {
    return new Promise((resolve, reject) => {
      Quagga.init({
        inputStream: {
          type: 'LiveStream',
          target: document.getElementById(regionId),
          constraints: {
            facingMode: 'environment',
            width:  { ideal: 1280 },
            height: { ideal: 720  },
          },
        },
        decoder: {
          readers: ['ean_reader'],
          multiple: false,
        },
        locate: true,
      }, (err) => {
        if (err) { reject(err); return; }
        running = 'quagga';
        Quagga.onDetected(handleQuaggaDetected);
        Quagga.start();
        resolve();
      });
    });
  }

  /* ---------- html5-qrcode last resort ---------- */

  async function startLegacy() {
    html5Qr = new Html5Qrcode(regionId);
    const config = {
      fps: 15,
      qrbox: (w, h) => {
        const qw = Math.min(Math.floor(w * 0.9), 400);
        const qh = Math.max(Math.min(Math.floor(qw / 2.5), Math.floor(h * 0.55)), 80);
        return { width: qw, height: qh };
      },
      formatsToSupport: [Html5QrcodeSupportedFormats.EAN_13],
    };
    await html5Qr.start({ facingMode: 'environment' }, config, (text) => report(text), () => {});
    running = 'legacy';
  }

  /* ---------- Public API ---------- */

  return { start, stop, isValidIsbn };
})();
