import { Alignment, Fit, Layout, Rive, RuntimeLoader, type ViewModelInstance } from '@rive-app/webgl2';
import wasmUrl from '@rive-app/webgl2/rive.wasm?url';

/**
 * The game's screens and HUD drawn by Rive. The Rive file (built from ui/ to
 * public/ui/fast5.riv) has one view model; the game sets its properties by name
 * and the file decides how they look and animate. See ui/CONTRACT.md for the
 * property list.
 *
 * Without the file (or with ?htmlhud) load() resolves to null and the HTML HUD
 * stays as it is.
 */

export type UiValue = number | string | boolean;

const SRC = `${import.meta.env.BASE_URL}ui/fast5.riv`;

// Serve the WASM from our own build rather than a CDN.
RuntimeLoader.setWasmUrl(wasmUrl);
RuntimeLoader.setWasmFallbackUrl(null);

export class RiveUi {
  private readonly vmi: ViewModelInstance;
  /** Property name -> its DataType ('number', 'string', 'boolean', 'enumType', 'trigger', ...). */
  private readonly types = new Map<string, string>();
  private readonly last = new Map<string, UiValue>();
  private readonly warned = new Set<string>();

  private constructor(
    private readonly rive: Rive,
    private readonly canvas: HTMLCanvasElement,
    vmi: ViewModelInstance,
  ) {
    this.vmi = vmi;
    for (const p of vmi.properties) this.types.set(p.name, String(p.type));
    window.addEventListener('resize', () => this.rive.resizeDrawingSurfaceToCanvas());
  }

  /** Load the Rive UI over the game, or null if there isn't one. */
  static async load(): Promise<RiveUi | null> {
    if (new URLSearchParams(location.search).has('htmlhud')) return null;
    // A .riv starts with "RIVE"; anything else (a dev server's index.html for a missing file) isn't one.
    const buffer = await fetch(SRC)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .catch(() => null);
    if (!buffer || new TextDecoder().decode(buffer.slice(0, 4)) !== 'RIVE') return null;
    const canvas = document.createElement('canvas');
    canvas.id = 'rive-ui';
    document.body.append(canvas);
    return new Promise((resolve) => {
      const fail = (why: unknown) => {
        console.info('Rive UI not loaded, using the HTML HUD:', why);
        canvas.remove();
        resolve(null);
      };
      let r: Rive;
      try {
        r = new Rive({
          buffer,
          canvas,
          autoplay: true,
          autoBind: true,
          // Fill the window and let the file's layouts place everything.
          layout: new Layout({ fit: Fit.Layout, alignment: Alignment.Center }),
          onLoad: () => {
            r.resizeDrawingSurfaceToCanvas();
            const vmi = r.viewModelInstance;
            if (!vmi) return fail('the file has no bound view model');
            resolve(new RiveUi(r, canvas, vmi));
          },
          onLoadError: (e) => fail(e),
        });
      } catch (e) {
        fail(e);
      }
    });
  }

  /** Whether the file has this property (i.e. draws the part of the UI that uses it). */
  has(name: string): boolean {
    return this.types.has(name);
  }

  /** Set a view model property. Writes only when the value changes; unknown names warn once. */
  set(name: string, value: UiValue): void {
    if (this.last.get(name) === value) return;
    const type = this.types.get(name);
    if (!type) return this.warn(name, 'no such property');
    this.last.set(name, value);
    switch (type) {
      case 'number': {
        const p = this.vmi.number(name);
        if (p) p.value = Number(value);
        break;
      }
      case 'string': {
        const p = this.vmi.string(name);
        if (p) p.value = String(value);
        break;
      }
      case 'boolean': {
        const p = this.vmi.boolean(name);
        if (p) p.value = Boolean(value);
        break;
      }
      case 'enumType': {
        const p = this.vmi.enum(name);
        if (p) p.value = String(value);
        break;
      }
      default:
        this.warn(name, `can't set a ${type}`);
    }
  }

  /** Fire a trigger property. */
  fire(name: string): void {
    const p = this.vmi.trigger(name);
    if (p) p.trigger();
    else this.warn(name, 'no such trigger');
  }

  /** Call back when the file changes a property (a click on a card, a confirm trigger). */
  on(name: string, cb: (value: UiValue | undefined) => void): void {
    const get = {
      trigger: () => this.vmi.trigger(name),
      number: () => this.vmi.number(name),
      boolean: () => this.vmi.boolean(name),
      string: () => this.vmi.string(name),
      enumType: () => this.vmi.enum(name),
    }[this.types.get(name) ?? ''];
    const p = get?.();
    if (!p) return this.warn(name, 'nothing to observe');
    p.on(() => cb('value' in p ? (p.value as UiValue) : undefined));
  }

  /** Let the UI take mouse input (menus) or pass it through to the game. */
  interactive(on: boolean): void {
    this.canvas.style.pointerEvents = on ? 'auto' : 'none';
  }

  private warn(name: string, why: string): void {
    if (this.warned.has(name)) return;
    this.warned.add(name);
    console.warn(`Rive UI: "${name}": ${why}`);
  }
}
