// Stub browser globals missing in Node.js test environment.
// Executes rAF callbacks synchronously — safe because emitStatusChange
// uses a sentinel (-1) before calling rAF to avoid assignment races.

globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
  cb(performance.now());
  return 0;
};

globalThis.cancelAnimationFrame = () => {};
