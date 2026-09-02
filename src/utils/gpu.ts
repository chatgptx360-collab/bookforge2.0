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
 *
 * And interrogating the adapter is still not enough. An adapter can pass every
 * check here and then refuse to produce a device: a 2011 GPU on a 2015 driver
 * offers a perfectly respectable-looking adapter and fails `requestDevice()`
 * with DXGI_ERROR_DEVICE_REMOVED, because D3D12 needs a WDDM 2.0 driver it
 * does not have. That happened to a real user, mid-sentence, after this code
 * had already promised them their graphics card was available. The only
 * honest test is to build a device and throw it away.
 */

interface AdapterInfo {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
}

interface MaybeDevice {
  destroy?: () => void;
}

interface MaybeAdapter {
  isFallbackAdapter?: boolean;
  info?: AdapterInfo;
  requestAdapterInfo?: () => Promise<AdapterInfo>;
  requestDevice?: () => Promise<MaybeDevice>;
}

/** Renderer names that mean "this is the CPU pretending to be a GPU". */
const SOFTWARE = /swiftshader|llvmpipe|lavapipe|basic render|software|warp|microsoft basic/i;

export interface GpuVerdict {
  usable: boolean;
  /** Why not, when it is not — shown to the user rather than guessed at. */
  reason: 'ok' | 'unsupported' | 'software' | 'unavailable' | 'device-failed';
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

  // The real test. Everything above is the adapter describing itself; this is
  // the driver being asked to do something. A device that cannot be created
  // here would have failed later, inside the model, as a dead run.
  if (typeof adapter.requestDevice !== 'function') {
    return { usable: false, reason: 'device-failed', describe: 'This adapter cannot create a device.' };
  }
  try {
    const device = await adapter.requestDevice();
    if (!device) {
      return { usable: false, reason: 'device-failed', describe: 'The graphics driver refused a device.' };
    }
    // Nothing is drawn with it; holding it open would keep the GPU awake.
    device.destroy?.();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      usable: false,
      reason: 'device-failed',
      // The driver's own words are worth keeping: DXGI_ERROR_DEVICE_REMOVED
      // and friends are searchable, where "GPU unavailable" is not.
      describe: `The graphics driver refused a device: ${detail}`,
    };
  }

  return { usable: true, reason: 'ok', describe: fingerprint.trim() || 'Hardware GPU.' };
}
