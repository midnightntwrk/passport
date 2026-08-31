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
 * honestly — it cannot and does not try to work around a denial. Every exit
 * path stops the tracks, the new ones included: a code found in a dropped image
 * unmounts the sheet, and the effect's cleanup is what stops the stream, so a
 * camera light left on after the sheet closed cannot happen through a path the
 * effect does not own.
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

  /**
   * The one funnel. `true` when the decoded text was a Passport payload and the
   * sheet is now finishing; `false` when it was a real code that is not ours,
   * which each path reports in its own words.
   */
  const consider = useCallback((decoded: string | null | undefined): boolean => {
    if (doneRef.current || !decoded) return false
    const payload = parseQrPayload(decoded)
    if (!payload) return false
    doneRef.current = true
    onResultRef.current(payload)
    return true
  }, [])

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
    let stream: MediaStream | null = null
    let timer: ReturnType<typeof setInterval> | null = null

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
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        })
      } catch (cause) {
        if (live) setState({ phase: 'unavailable', reason: cameraRefusalSentence(cause) })
        return
      }
      if (!live) {
        stream.getTracks().forEach((track) => track.stop())
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
          timer = setInterval(() => {
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
      timer = setInterval(() => {
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

    return () => {
      live = false
      if (timer !== null) clearInterval(timer)
      stream?.getTracks().forEach((track) => track.stop())
    }
  }, [consider])

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
