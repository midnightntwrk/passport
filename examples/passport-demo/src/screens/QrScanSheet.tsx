import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ImageDown, Loader2, X } from 'lucide-react'

import { parseQrPayload, type QrPayload } from '../lib/qrPayload.js'

import './home.css'

/**
 * The QR scanner — points a camera at a code, or reads one out of an image,
 * and hands back the first Passport payload it sees.
 *
 * TWO WAYS IN, BECAUSE THERE ARE TWO KINDS OF MACHINE
 * --------------------------------------------------
 * Until 2026/08/31 this sheet was the camera and nothing else, which is why it
 * had only ever worked on a phone: a laptop with no webcam, or with one facing
 * the wrong way, got a refusal sentence and no way forward — and a laptop is
 * exactly where somebody is looking at a Receive code on a second screen or
 * holding one as a file. So the camera is now the first path rather than the
 * only one, and an image drop / paste / file-picker sits under it at all times,
 * including under the refusal. Neither is a fallback in the UI's voice; both
 * are simply offered.
 *
 * Detection prefers the platform's own `BarcodeDetector` (Chrome and Edge on
 * Android ship it); everywhere else — iOS Safari most importantly, since that
 * is where the installed PWA lives — frames are sampled onto a canvas and
 * decoded by jsQR, loaded lazily so the library costs nothing until a scanner
 * actually opens. The dropped-image path is always jsQR, on a still frame
 * rather than a stream, so it can afford `attemptBoth` inversions: a screenshot
 * of a dark-mode code is inverted, and re-trying costs a few milliseconds once
 * rather than on every video tick.
 *
 * Both paths funnel through `parseQrPayload`. A QR that decodes but is not ours
 * — a URL, a Wi-Fi config — keeps the camera running with a "keep scanning"
 * line rather than closing on garbage, and earns the image zone its own honest
 * sentence rather than silence.
 *
 * THE CAMERA IS A PERMISSION THE BROWSER OWNS
 * -------------------------------------------
 * This sheet asks by calling `getUserMedia` and reports the browser's refusal
 * honestly — it cannot and does not try to work around a denial. It asks for
 * VIDEO ONLY: `audio: false` is written out rather than left off, because an
 * omitted key and a false one are the same to the specification but not to a
 * reader, and this is the one line that decides whether opening a scanner can
 * take somebody's microphone.
 *
 * LETTING GO IS A FEATURE, NOT A CLEAN-UP DETAIL (2026/08/31)
 * ----------------------------------------------------------
 * On a call that day the scan button took the camera and the microphone away
 * from a screen share, and the presenter's video and audio were gone for two
 * minutes. A capture device is exclusive on most platforms: whatever holds it
 * is the only thing that has it, so a sheet that keeps a track alive one second
 * longer than it needs is taking that second from something else.
 *
 * So the stream is held in a ref rather than in the effect's closure, and
 * {@link QrScanSheet}'s `release` is the ONE thing that stops a track. Every
 * way out of this sheet goes through it:
 *
 *   close      the button, the scrim, and Escape all unmount the sheet;
 *   unmount    the effect's cleanup calls it, whatever caused the unmount;
 *   a scan     `consider` calls it BEFORE handing the payload up, so the
 *              camera is already off while the host is still deciding what to
 *              do about it — the unmount that follows is a second or two of
 *              React later, and that is a second or two of somebody's webcam;
 *   leaving    `pagehide` calls it. React's cleanup does not run when a
 *              document is navigated away from or frozen into the back/forward
 *              cache, so a sheet left open at that moment is exactly the state
 *              that held the camera for two minutes.
 *
 * `release` also clears the sampling interval and drops the video element's
 * `srcObject`: a stopped track behind a live `srcObject` is enough to keep some
 * platforms' capture indicator lit, and an interval sampling a dead stream is
 * work nobody asked for.
 */

/** How often fallback sampling runs. Detection latency, not video smoothness. */
const SAMPLE_INTERVAL_MS = 180

interface QrScanSheetProps {
  /**
   * Called once with the first Passport payload seen, from either path; the
   * sheet closes itself. A name payload is a `.night` name and, where the code
   * carried one, the account it CLAIMS to point at — a cross-check for the
   * caller to make against the registry, never a destination on its own.
   */
  onResult: (payload: QrPayload) => void
  onClose: () => void
}

type ScanState =
  | { phase: 'starting' }
  | { phase: 'scanning'; sawOtherCode: boolean }
  | { phase: 'unavailable'; reason: string }

/** Where the dropped / pasted / chosen image has got to. */
type ImageState = { kind: 'idle' } | { kind: 'reading' } | { kind: 'failed'; reason: string }

/** The browser's refusal, in a sentence a user can act on. */
function cameraRefusalSentence(cause: unknown): string {
  const name =
    typeof cause === 'object' && cause !== null && typeof (cause as { name?: unknown }).name === 'string'
      ? (cause as { name: string }).name
      : ''
  if (name === 'NotAllowedError') {
    return 'Camera access was declined. Allow the camera for this site in your browser settings, or use an image below.'
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No camera was found on this device — read the code from an image instead.'
  }
  if (name === 'NotReadableError') {
    return 'The camera is in use by another app — read the code from an image instead.'
  }
  if (name === 'NotSupportedError') {
    return 'This browser cannot open a camera — read the code from an image instead.'
  }
  const message = cause instanceof Error && cause.message ? ` (${cause.message})` : ''
  return `The camera could not be started${message}. Read the code from an image instead.`
}

export default function QrScanSheet({ onResult, onClose }: QrScanSheetProps) {
  const [state, setState] = useState<ScanState>({ phase: 'starting' })
  const [image, setImage] = useState<ImageState>({ kind: 'idle' })
  const [dragging, setDragging] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  /* `onResult` fires exactly once even if a drop lands mid-detection-tick. */
  const doneRef = useRef(false)
  /* The camera, held where every exit can reach it rather than inside the
     effect that opened it. See the module header. */
  const streamRef = useRef<MediaStream | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  /**
   * Lets the camera go. The ONLY thing in this file that stops a track.
   *
   * Idempotent, and deliberately so: it is called from four places that can
   * happen in either order — a scan that closes the sheet also unmounts it, and
   * a `pagehide` during a scan does both — and an exit path that had to know
   * whether another had already run would be an exit path that sometimes did
   * not run at all.
   */
  const release = useCallback((): void => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    const stream = streamRef.current
    streamRef.current = null
    if (stream) for (const track of stream.getTracks()) track.stop()
    /* A stopped track behind a live `srcObject` still reads as a held device
       to some platforms' capture indicator. */
    const video = videoRef.current
    if (video) video.srcObject = null
  }, [])

  /* The callback behind a ref, so `consider` — and therefore the camera effect
     that depends on it — is stable for the sheet's whole life. The host passes
     an inline arrow; without this, every re-render of the Send sheet underneath
     (the fee poll ticks every five seconds) would tear the stream down and
     start the camera again, which is a black viewport that keeps blinking.
     Declared FIRST so it is refreshed before the camera effect below it runs on
     the same commit. */
  const onResultRef = useRef(onResult)
  useEffect(() => {
    onResultRef.current = onResult
  })

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /* LEAVING THE DOCUMENT. A component's cleanup does not run when the page is
     navigated away from, closed, or frozen into the back/forward cache — the
     tree is simply gone — so nothing else here would let the camera go. This
     is the listener that does. `pagehide` rather than `unload` because it is
     the one that fires for a bfcache freeze, which is the case where the page
     lives on with its camera still open. */
  useEffect(() => {
    const onPageHide = () => release()
    window.addEventListener('pagehide', onPageHide)
    return () => window.removeEventListener('pagehide', onPageHide)
  }, [release])

  /**
   * The one funnel. `true` when the decoded text was a Passport payload and the
   * sheet is now finishing; `false` when it was a real code that is not ours,
   * which each path reports in its own words.
   */
  const consider = useCallback(
    (decoded: string | null | undefined): boolean => {
      if (doneRef.current || !decoded) return false
      const payload = parseQrPayload(decoded)
      if (!payload) return false
      doneRef.current = true
      /* BEFORE the payload goes up, not after. The host closes this sheet in
         response, and that close is a React commit away — a commit during
         which the camera would still be somebody else's to lose. */
      release()
      onResultRef.current(payload)
      return true
    },
    [release],
  )

  /**
   * The image path: a file dropped, pasted, or chosen. Decoded off a canvas,
   * which is why it is thin — jsdom has no canvas, so the reasoning worth
   * testing lives in `parseQrPayload` and this stays a pipe into it.
   */
  const readImage = useCallback(
    async (file: Blob): Promise<void> => {
      if (doneRef.current) return
      setImage({ kind: 'reading' })
      try {
        const bitmap = await createImageBitmap(file)
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) {
          setImage({ kind: 'failed', reason: 'This browser could not read that image.' })
          return
        }
        context.drawImage(bitmap, 0, 0)
        bitmap.close()
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
        const { default: jsQR } = await import('jsqr')
        const code = jsQR(pixels.data, pixels.width, pixels.height, {
          // A still frame can afford both polarities; a screenshot of a
          // dark-mode code is an inverted one.
          inversionAttempts: 'attemptBoth',
        })
        if (!code) {
          setImage({
            kind: 'failed',
            reason: 'No QR code was found in that image. Try a closer or sharper picture of it.',
          })
          return
        }
        if (!consider(code.data)) {
          setImage({ kind: 'failed', reason: 'That code is not a Midnight name or address.' })
        }
      } catch {
        setImage({ kind: 'failed', reason: 'That file could not be opened as an image.' })
      }
    },
    [consider],
  )

  /* Paste, best-effort: desktop browsers put a copied screenshot on the
     clipboard as a file, and reading it is the fastest path of the three.
     iOS delivers paste events unreliably inside an installed PWA, which is why
     the drop zone and the file picker are the load-bearing ones. */
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const items = event.clipboardData?.items
      if (!items) return
      for (const item of Array.from(items)) {
        if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
        const file = item.getAsFile()
        if (!file) continue
        event.preventDefault()
        void readImage(file)
        return
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [readImage])

  useEffect(() => {
    let live = true

    const considerFrame = (decoded: string | null | undefined): void => {
      if (!live || !decoded) return
      if (consider(decoded)) return
      // A real QR that is not ours: say so once, keep scanning.
      setState((prev) =>
        prev.phase === 'scanning' && prev.sawOtherCode ? prev : { phase: 'scanning', sawOtherCode: true },
      )
    }

    void (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setState({
          phase: 'unavailable',
          reason: 'This browser does not offer camera access — read the code from an image instead.',
        })
        return
      }
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          /* VIDEO ONLY. `audio: false` is written rather than omitted: the two
             mean the same thing to the browser and very different things to a
             reader, and this is the line that decides whether a scanner can
             take a microphone. */
          video: { facingMode: 'environment' },
          audio: false,
        })
      } catch (cause) {
        if (live) setState({ phase: 'unavailable', reason: cameraRefusalSentence(cause) })
        return
      }
      /* Recorded the instant it exists, so a teardown that happens between
         here and the next line still has something to stop. */
      streamRef.current = stream
      if (!live) {
        release()
        return
      }
      const video = videoRef.current
      if (!video) return
      video.srcObject = stream
      await video.play().catch(() => undefined)
      if (!live) return
      setState({ phase: 'scanning', sawOtherCode: false })

      /* The platform detector, where it exists. Constructing it can itself
         throw on partial implementations, which falls through to jsQR. */
      const DetectorCtor = (
        window as { BarcodeDetector?: new (options: { formats: string[] }) => { detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>> } }
      ).BarcodeDetector
      if (DetectorCtor) {
        try {
          const detector = new DetectorCtor({ formats: ['qr_code'] })
          timerRef.current = setInterval(() => {
            if (doneRef.current || video.readyState < 2) return
            void detector
              .detect(video)
              .then((codes) => considerFrame(codes[0]?.rawValue))
              .catch(() => undefined) // A bad frame is not a failed scan.
          }, SAMPLE_INTERVAL_MS)
          return
        } catch {
          // Fall through to the canvas path.
        }
      }

      const { default: jsQR } = await import('jsqr')
      if (!live) return
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) {
        setState({
          phase: 'unavailable',
          reason: 'This browser could not decode camera frames — read the code from an image instead.',
        })
        return
      }
      timerRef.current = setInterval(() => {
        if (doneRef.current || video.readyState < 2 || video.videoWidth === 0) return
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        context.drawImage(video, 0, 0)
        const frame = context.getImageData(0, 0, canvas.width, canvas.height)
        const code = jsQR(frame.data, frame.width, frame.height, {
          inversionAttempts: 'dontInvert',
        })
        considerFrame(code?.data)
      }, SAMPLE_INTERVAL_MS)
    })()

    /* UNMOUNT, whatever caused it — the close button, the scrim, Escape, a
       successful scan, or the whole surface behind this one going away. */
    return () => {
      live = false
      release()
    }
  }, [consider, release])

  const takeFiles = (files: FileList | null | undefined): void => {
    const file = files?.[0]
    if (file) void readImage(file)
  }

  return createPortal(
    <div className="mnhome-addr-scrim" onClick={onClose} role="presentation">
      <div
        className="mnhome-addr-modal mnhome-qrscan"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mnhome-qrscan-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mnhome-addr-head">
          <p className="mnhome-micro" id="mnhome-qrscan-title">
            Scan a Passport code
          </p>
          <button type="button" className="mnhome-icon-button" onClick={onClose} aria-label="Close">
            <X size={15} aria-hidden="true" />
          </button>
        </div>

        {state.phase === 'unavailable' ? (
          <p className="mnhome-send-error" role="alert">
            {state.reason}
          </p>
        ) : (
          <>
            <div className="mnhome-qrscan-viewport">
              {/* playsInline keeps iOS from hijacking the stream into a
                  full-screen player; muted is required for autoplay. */}
              <video ref={videoRef} playsInline muted className="mnhome-qrscan-video" />
              <div className="mnhome-qrscan-reticle" aria-hidden="true" />
            </div>
            <p className="mnhome-send-hint" aria-live="polite">
              {state.phase === 'starting'
                ? 'Starting the camera…'
                : state.sawOtherCode
                  ? 'That code is not a Midnight name or address — keep scanning.'
                  : 'Point the camera at a Passport code, or at a Midnight address.'}
            </p>
          </>
        )}

        {/* Always offered, camera or no camera: a code on a second screen, or
            saved as a file, is the desktop case the camera never covered. */}
        <div
          className={`mnhome-qrdrop${dragging ? ' is-dragging' : ''}`}
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            takeFiles(event.dataTransfer?.files)
          }}
        >
          {image.kind === 'reading' ? (
            <Loader2 className="mnhome-send-spinner" size={16} aria-hidden="true" />
          ) : (
            <ImageDown size={16} aria-hidden="true" />
          )}
          <p className="mnhome-qrdrop-copy">
            {image.kind === 'reading' ? (
              'Reading that image…'
            ) : (
              <>
                Drop or paste an image of a code, or{' '}
                <button
                  type="button"
                  className="mnhome-qrdrop-pick"
                  onClick={() => fileRef.current?.click()}
                >
                  choose a file
                </button>
                .
              </>
            )}
          </p>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="mnhome-qrdrop-input"
            tabIndex={-1}
            onChange={(event) => {
              takeFiles(event.target.files)
              // Let the same file be chosen twice after a failed read.
              event.target.value = ''
            }}
          />
        </div>
        {image.kind === 'failed' ? (
          <p className="mnhome-send-error" role="alert">
            {image.reason}
          </p>
        ) : null}
      </div>
    </div>,
    document.body,
  )
}
