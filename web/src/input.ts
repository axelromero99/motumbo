// Local keyboard input for up to two players (used until netcode lands).
// Produces the same packed uint32 per player that the sim consumes.

export const IN_UP = 1;
export const IN_DOWN = 2;
export const IN_LEFT = 4;
export const IN_RIGHT = 8;
export const IN_DASH = 16;
export const IN_JUMP = 32;
export const IN_BRACE = 64;

const P1_KEYS: Record<string, number> = {
  KeyW: IN_UP,
  KeyS: IN_DOWN,
  KeyA: IN_LEFT,
  KeyD: IN_RIGHT,
  ShiftLeft: IN_DASH,
  Space: IN_JUMP,
  ControlLeft: IN_BRACE,
};

const P2_KEYS: Record<string, number> = {
  ArrowUp: IN_UP,
  ArrowDown: IN_DOWN,
  ArrowLeft: IN_LEFT,
  ArrowRight: IN_RIGHT,
  ShiftRight: IN_DASH,
  ControlRight: IN_JUMP,
  Period: IN_BRACE,
};

export class LocalInput {
  readonly words = new Uint32Array(8);
  onReset: (() => void) | null = null;
  onSelectLevel: ((level: number) => void) | null = null;
  onPause: (() => void) | null = null;
  onCamera: (() => void) | null = null;
  /** LOCAL 2-player: arrows drive P2. Single human (SOLO/online): arrows also
   *  drive the one player (words[0]), so WASD and arrows both work. */
  dualLocal = false;

  constructor() {
    // Let text fields (username, room code) receive every key — otherwise the
    // gameplay bindings (WASD, Space, R, digits, C…) swallow those letters.
    const typing = (e: KeyboardEvent): boolean => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    };
    window.addEventListener('keydown', (e) => {
      if (typing(e)) return;
      if (e.code === 'KeyR') {
        this.onReset?.();
        return;
      }
      if (e.code.startsWith('Digit')) {
        const n = Number(e.code.slice(5));
        if (n >= 1 && n <= 8) this.onSelectLevel?.(n - 1);
        return;
      }
      if (e.code === 'Escape') {
        this.onPause?.();
        return;
      }
      if (e.code === 'KeyC') {
        this.onCamera?.();
        return;
      }
      if (this.apply(e.code, true)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      if (typing(e)) return;
      if (this.apply(e.code, false)) e.preventDefault();
    });
    window.addEventListener('blur', () => this.words.fill(0));
  }

  private set(slot: number, bit: number, down: boolean): void {
    this.words[slot] = down ? this.words[slot] | bit : this.words[slot] & ~bit;
  }

  private apply(code: string, down: boolean): boolean {
    let handled = false;
    const p1 = P1_KEYS[code];
    if (p1 !== undefined) {
      this.set(0, p1, down);
      handled = true;
    }
    const p2 = P2_KEYS[code];
    if (p2 !== undefined) {
      // Second player only in couch 2P; otherwise the arrows are a second
      // control scheme for the single human.
      this.set(this.dualLocal ? 1 : 0, p2, down);
      handled = true;
    }
    return handled;
  }
}
