/**
 * Vercel serverless entry point.
 *
 * pdf-lib (and the canvas code paths inside pdf-parse) touch a handful of DOM
 * constructors at module-evaluation time. Node has none of them, so we install
 * inert shims *before* the bundled Express app is imported — the shims are only
 * ever used for feature detection, never for real rendering.
 */
class NoopDOMMatrix {
  constructor() {
    this.a = 1;
    this.b = 0;
    this.c = 0;
    this.d = 1;
    this.e = 0;
    this.f = 0;
  }
}

class NoopImageData {
  constructor(width = 0, height = 0) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(Math.max(0, width * height * 4));
  }
}

class NoopPath2D {
  addPath() {}
  closePath() {}
  moveTo() {}
  lineTo() {}
}

globalThis.DOMMatrix ??= NoopDOMMatrix;
globalThis.ImageData ??= NoopImageData;
globalThis.Path2D ??= NoopPath2D;

// The bundle lives outside `dist/` so Vercel never publishes it (and its
// sourcemap) as downloadable static assets.
const { app } = await import('../server-build/server.cjs');

export default app;

export const config = {
  api: {
    // Express reads the raw stream itself (multer + express.json).
    bodyParser: false,
  },
};
