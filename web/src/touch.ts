// Touch controls for phones/tablets: a left virtual joystick + right action
// buttons. They write the SAME packed input word as the keyboard (words[0]), so
// everything downstream — including the third-person camera-relative remap —
// works unchanged. Hidden on non-touch devices.
import { LocalInput, IN_UP, IN_DOWN, IN_LEFT, IN_RIGHT, IN_DASH, IN_JUMP, IN_BRACE } from './input';

const DIR = IN_UP | IN_DOWN | IN_LEFT | IN_RIGHT;
const THROW = 46; // px from centre for a full push
const DEAD = 0.4; // normalized deadzone before a direction registers

export interface TouchControls {
  show(visible: boolean): void;
}

export function setupTouch(input: LocalInput): TouchControls {
  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

  const root = document.createElement('div');
  root.className = 'touch-controls';
  root.style.display = 'none';

  const stick = document.createElement('div');
  stick.className = 'touch-stick';
  const nub = document.createElement('div');
  nub.className = 'touch-nub';
  stick.appendChild(nub);
  root.appendChild(stick);

  const btnWrap = document.createElement('div');
  btnWrap.className = 'touch-btns';
  const mkBtn = (label: string, bit: number, cls: string): void => {
    const btn = document.createElement('button');
    btn.className = `touch-btn ${cls}`;
    btn.textContent = label;
    const on = (e: Event): void => {
      e.preventDefault();
      input.words[0] |= bit;
      btn.classList.add('down');
    };
    const off = (e: Event): void => {
      e.preventDefault();
      input.words[0] &= ~bit;
      btn.classList.remove('down');
    };
    btn.addEventListener('touchstart', on, { passive: false });
    btn.addEventListener('touchend', off);
    btn.addEventListener('touchcancel', off);
    btnWrap.appendChild(btn);
  };
  mkBtn('⤒', IN_JUMP, 'jump');
  mkBtn('»', IN_DASH, 'dash');
  mkBtn('🛡', IN_BRACE, 'brace');
  root.appendChild(btnWrap);
  document.body.appendChild(root);

  // Joystick tracking (a single finger owns it, tracked by identifier).
  let touchId = -1;
  let cx = 0;
  let cy = 0;
  const clearDir = (): void => {
    input.words[0] &= ~DIR;
    nub.style.transform = 'translate(-50%, -50%)';
  };
  const setDir = (dx: number, dy: number): void => {
    const kx = Math.max(-1, Math.min(1, dx / THROW));
    const ky = Math.max(-1, Math.min(1, dy / THROW));
    let w = input.words[0] & ~DIR;
    if (ky < -DEAD) w |= IN_UP; // finger up = W = −Z
    if (ky > DEAD) w |= IN_DOWN;
    if (kx < -DEAD) w |= IN_LEFT;
    if (kx > DEAD) w |= IN_RIGHT;
    input.words[0] = w;
    nub.style.transform = `translate(calc(-50% + ${kx * 30}px), calc(-50% + ${ky * 30}px))`;
  };
  stick.addEventListener(
    'touchstart',
    (e) => {
      e.preventDefault();
      const t = e.changedTouches[0];
      touchId = t.identifier;
      const r = stick.getBoundingClientRect();
      cx = r.left + r.width / 2;
      cy = r.top + r.height / 2;
      setDir(t.clientX - cx, t.clientY - cy);
    },
    { passive: false },
  );
  window.addEventListener(
    'touchmove',
    (e) => {
      if (touchId < 0) return;
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === touchId) {
          e.preventDefault();
          setDir(t.clientX - cx, t.clientY - cy);
        }
      }
    },
    { passive: false },
  );
  const endStick = (e: TouchEvent): void => {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === touchId) {
        touchId = -1;
        clearDir();
      }
    }
  };
  window.addEventListener('touchend', endStick);
  window.addEventListener('touchcancel', endStick);

  let shown = false;
  return {
    show(visible: boolean): void {
      const want = isTouch && visible;
      if (want === shown) return;
      shown = want;
      root.style.display = want ? 'block' : 'none';
      if (!want) clearDir();
    },
  };
}
