import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

import { extractMidnightAddress } from '../lib/qrScan.js'

import './home.css'

/**
 * The camera QR scanner — points the rear camera at a code and hands back the
 * first plausible Midnight address it sees.
 *
 * Detection prefers the platform's own `BarcodeDetector` (Chrome and Edge on
 * Android ship it); everywhere else — iOS Safari most importantly, since that
 * is where the installed PWA lives — frames are sampled onto a canvas and
 * decoded by jsQR, loaded lazily so the library costs nothing until a scanner
 * actually opens. Both paths feed `extractMidnightAddress`: a QR that decodes
 * but does not look like an address (a URL, a Wi-Fi config) keeps the camera
 * running with a "keep scanning" line rather than closing on garbage.
 *
 * The camera is a permission the browser owns: this sheet asks by calling
 * `getUserMedia` and reports the browser's refusal honestly — it cannot and
 * does not try to work around a denial. Every exit path stops the tracks; a
 * camera light left on after the sheet closed would be the UI lying about
 * what it is doing.
 */

/** How often fallback sampling runs. Detection latency, not video smoothness. */
const SAMPLE_INTERVAL_MS = 180

interface QrScanSheetProps {
  /** Called once with the first plausible address; the sheet closes itself. */
  onAddress: (address: string) => void
  onClose: () => void
}

type ScanState =
  | { phase: 'starting' }
  | { phase: 'scanning'; sawNonAddress: boolean }
  | { phase: 'unavailable'; reason: string }

/** The browser's refusal, in a sentence a user can act on. */
function cameraRefusalSentence(cause: unknown): string {
  const name =
    typeof cause === 'object' && cause !== null && typeof (cause as { name?: unknown }).name === 'string'
      ? (cause as { name: string }).name
      : ''
  if (name === 'NotAllowedError') {
    return 'Camera access was declined. Allow the camera for this site in your browser settings, then try again.'
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No camera was found on this device.'
  }
  if (name === 'NotReadableError') {
    return 'The camera is in use by another app.'
  }
  const message = cause instanceof Error && cause.message ? ` (${cause.message})` : ''
  return `The camera could not be started${message}.`
}

export default function QrScanSheet({ onAddress, onClose }: QrScanSheetProps) {
  const [state, setState] = useState<ScanState>({ phase: 'starting' })
  const videoRef = useRef<HTMLVideoElement | null>(null)
  /* `onAddress` fires exactly once even if two detection ticks race. */
  const doneRef = useRef(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const found = useCallback(
    (address: string) => {
      if (doneRef.current) return
      doneRef.current = true
      onAddress(address)
    },
    [onAddress],
  )

  useEffect(() => {
    let live = true
    let stream: MediaStream | null = null
    let timer: ReturnType<typeof setInterval> | null = null

    const consider = (decoded: string | null | undefined): void => {
      if (!live || !decoded) return
      const address = extractMidnightAddress(decoded)
      if (address) {
        found(address)
        return
      }
      // A real QR that is not an address: say so once, keep scanning.
      setState((prev) =>
        prev.phase === 'scanning' && prev.sawNonAddress ? prev : { phase: 'scanning', sawNonAddress: true },
      )
    }

    void (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setState({ phase: 'unavailable', reason: 'This browser does not offer camera access.' })
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
      setState({ phase: 'scanning', sawNonAddress: false })

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
              .then((codes) => consider(codes[0]?.rawValue))
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
        setState({ phase: 'unavailable', reason: 'This browser could not decode camera frames.' })
        return
      }
      timer = setInterval(() => {
        if (doneRef.current || video.readyState < 2 || video.videoWidth === 0) return
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        context.drawImage(video, 0, 0)
        const image = context.getImageData(0, 0, canvas.width, canvas.height)
        const code = jsQR(image.data, image.width, image.height, {
          inversionAttempts: 'dontInvert',
        })
        consider(code?.data)
      }, SAMPLE_INTERVAL_MS)
    })()

    return () => {
      live = false
      if (timer !== null) clearInterval(timer)
      stream?.getTracks().forEach((track) => track.stop())
    }
  }, [found])

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
            Scan a Midnight address
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
                : state.sawNonAddress
                  ? 'That code is not a Midnight address — keep scanning.'
                  : 'Point the camera at a QR code carrying an mn_addr… address.'}
            </p>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}
