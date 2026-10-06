// Deliberate wake: the cursor rests on the wake strip, no mouse button is
// held, and Rust gets the final word (full-screen apps stay quiet). Kept here
// because it is a small state machine rather than an event handler.

export interface WakeHoldOpts {
  /** Dwell in ms, read fresh when the strip is entered; 0 wakes instantly. */
  dwellMs: () => number;
  /** Whether the island is still hidden when the dwell ends. */
  stillHidden: () => boolean;
  /** Final word from Rust; null (no Tauri) counts as allowed. */
  allowed: () => Promise<boolean | null>;
  wake: () => void;
}

export class WakeHold {
  private timer: number | null = null;
  /** Invalidates an in-flight dwell or a Rust check when the hover ends. */
  private token = 0;
  private buttons = 0;

  constructor(private readonly opts: WakeHoldOpts) {}

  /** The pointer entered the strip. */
  enter(buttons: number) {
    this.buttons = buttons;
    this.cancel();
    if (buttons !== 0) return;
    const token = this.token;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      if (token !== this.token || this.buttons !== 0 || !this.opts.stillHidden()) return;
      void this.opts.allowed().then((ok) => {
        if (token !== this.token || ok === false) return;
        this.opts.wake();
      });
    }, Math.max(0, this.opts.dwellMs()));
  }

  /** Pointer moved over the strip: a held button cancels the dwell. */
  move(buttons: number) {
    this.buttons = buttons;
    if (buttons !== 0) this.cancel();
  }

  /** Pointer left the strip. */
  leave() {
    this.cancel();
  }

  cancel() {
    this.token += 1;
    if (this.timer != null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
