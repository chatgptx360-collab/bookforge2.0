/**
 * Is there a *real* GPU here?
 *
 * `requestAdapter()` resolving is not the question. Chrome hands back a
 * software adapter — SwiftShader, or lavapipe on Linux — when hardware
 * acceleration is off, the driver is blocklisted, or the machine is a VM. That
 * adapter satisfies every WebGPU call and reports itself as `chrome://gpu`'s
 * "Software only".
 *
 * Taking it at face value is worse than having no GPU at all: the WebGPU path
 * fetches the full-precision weights, four times the download, and then runs
 * them on a CPU rasterizer that is slower than the quantised WASM build it
 * replaced. So the adapter has to be interrogated, not merely obtained.
 */

interface AdapterInfo {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
}

interface MaybeAdapter {
  isFallbackAdapter?: boolean;
  info?: AdapterInfo;
  requestAdapterInfo?: () => Promise<AdapterInfo>;
}

/** Renderer names that mean "this is the CPU pretending to be a GPU". */
const SOFTWARE = /swiftshader|llvmpipe|lavapipe|basic render|software|warp|microsoft basic/i;

export interface GpuVerdict {
  usable: boolean;
  /** Why not, when it is not — shown to the user rather than guessed at. */
  reason: 'ok' | 'unsupported' | 'software' | 'unavailable';
  describe: string;
}

export async function inspectGpu(scope: { navigator?: Navigator } = globalThis): Promise<GpuVerdict> {
  const gpu = (scope.navigator as { gpu?: { requestAdapter(options?: unknown): Promise<unknown> } } | undefined)?.gpu;
  if (!gpu) {
    return { usable: false, reason: 'unsupported', describe: 'This browser does not expose WebGPU.' };
  }

  let adapter: MaybeAdapter | null = null;
  try {
    // Ask explicitly for hardware; never accept a fallback silently.
    adapter = (await gpu.requestAdapter({
      powerPreference: 'high-performance',
      forceFallbackAdapter: false,
    })) as MaybeAdapter | null;
  } catch {
    adapter = null;
  }

  if (!adapter) {
    return { usable: false, reason: 'unavailable', describe: 'No graphics adapter was offered to the page.' };
  }

  if (adapter.isFallbackAdapter) {
    return { usable: false, reason: 'software', describe: 'WebGPU is present but running on software.' };
  }

  // `info` is the current spec; `requestAdapterInfo()` is the older spelling.
  let info: AdapterInfo | undefined = adapter.info;
  if (!info && typeof adapter.requestAdapterInfo === 'function') {
    try {
      info = await adapter.requestAdapterInfo();
    } catch {
      info = undefined;
    }
  }

  const fingerprint = [info?.vendor, info?.architecture, info?.device, info?.description]
    .filter(Boolean)
    .join(' ');
  if (fingerprint && SOFTWARE.test(fingerprint)) {
    return { usable: false, reason: 'software', describe: `Software renderer (${fingerprint.trim()}).` };
  }

  return { usable: true, reason: 'ok', describe: fingerprint.trim() || 'Hardware GPU.' };
}
