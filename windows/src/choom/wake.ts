// Deliberate wake: the cursor rests on the wake strip, no mouse button is
// held, and Rust gets the final word (full-screen apps stay quiet). Kept here
// because it is a small state machine rather than an event handler.
//
// Hidden Rust polling stays parked: this class only arms a dwell timer while
// the pointer is over the strip, and the async fullscreen check is guarded by
// a token so a stale response can never wake after exit, drag, fullscreen or
// collapse. A held button cancels; releasing over the strip rearms once.
// Plain moves never restart the dwell.

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
  private checking = false;

  constructor(private readonly opts: WakeHoldOpts) {}

  /** The pointer entered the strip. */
  enter(buttons: number) {
    this.buttons = buttons;
    this.cancel();
    if (buttons !== 0) return;
    this.arm();
  }

  /** Pointer moved over the strip. */
  move(buttons: number) {
    const prev = this.buttons;
    this.buttons = buttons;
    if (buttons !== 0) {
      this.cancel();
      return;
    }
    // Released while still over the strip: rearm once.
    if (prev !== 0) {
      this.cancel();
      this.arm();
      return;
    }
    // Cursor already over the strip after collapse: the first move arms the
    // dwell. Later moves keep it; they never restart it.
    if (this.timer == null && !this.checking) this.arm();
  }

  /** A press without movement fires no mousemove, so it must cancel too. */
  down(buttons: number) {
    this.buttons = buttons;
    if (buttons !== 0) this.cancel();
  }

  /** The button was released over the strip without moving. */
  release(buttons: number = 0) {
    // Preserve other held buttons: a right button still held must not wake.
    this.buttons = buttons;
    if (buttons !== 0) {
      this.cancel();
      return;
    }
    if (this.timer == null && !this.checking) {
      this.cancel();
      this.arm();
    }
  }

  /** Pointer left the strip. */
  leave() {
    this.cancel();
  }

  cancel() {
    this.token += 1;
    this.checking = false;
    if (this.timer != null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private arm() {
    if (!this.opts.stillHidden()) return;
    const token = this.token;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      if (token !== this.token || this.buttons !== 0 || !this.opts.stillHidden()) return;
      this.checking = true;
      void this.opts.allowed().then(
        (ok) => {
          // Only the matching check may stand down: a stale response must not
          // clear a newer dwell.
          if (token !== this.token) return;
          this.checking = false;
          if (ok === false) return;
          if (this.buttons !== 0 || !this.opts.stillHidden()) return;
          this.opts.wake();
        },
        () => {
          // A rejecting gate recovers quietly: the next entry arms again.
          if (token !== this.token) return;
          this.checking = false;
        },
      );
    }, Math.max(0, this.opts.dwellMs()));
  }
}
