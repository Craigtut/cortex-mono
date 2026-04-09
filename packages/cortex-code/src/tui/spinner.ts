import { Text, type TUI } from '@mariozechner/pi-tui';
import chalk from 'chalk';

// ---------------------------------------------------------------------------
// Whimsical thinking words (picked randomly each time the spinner starts)
// ---------------------------------------------------------------------------
const THINKING_WORDS = [
  'Thinking',     'Musing',        'Brewing',       'Doodling',
  'Bubbling',     'Rummaging',     'Woolgathering', 'Waffling',
  'Larking',      'Slurping',      'Fizzing',       'Dawdling',
  'Whittling',    'Burbling',      'Gallivanting',  'Unfurling',
  'Steeping',     'Fermenting',    'Sauntering',    'Oscillating',
  'Kindling',     'Humming',       'Sifting',       'Weaving',
  'Ambling',      'Roving',        'Stirring',      'Gleaning',
  'Idling',       'Lilting',
];

export function randomThinkingLabel(): string {
  return THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)]! + '\u2026';
}

// ---------------------------------------------------------------------------
// Global tempo (>1 = slower). Applied to every braille frame automatically.
// ---------------------------------------------------------------------------
const TEMPO = 1.21;

// ---------------------------------------------------------------------------
// Brightness tints (teal spectrum matching brand primary #00E5CC)
// ---------------------------------------------------------------------------
const TINT = {
  dim:    chalk.hex('#1B6E60'),
  mid:    chalk.hex('#00A898'),
  bright: chalk.hex('#00E5CC'),
} as const;

type Tint = keyof typeof TINT;

// ---------------------------------------------------------------------------
// Braille cell helpers
// ---------------------------------------------------------------------------
// Dot layout:     Bit masks:
//   1  4           0x01  0x08
//   2  5           0x02  0x10
//   3  6           0x04  0x20
//   7  8           0x40  0x80

// Individual dots
const DOT1 = 0x01; const DOT2 = 0x02; const DOT3 = 0x04; const DOT4 = 0x08;
const DOT5 = 0x10; const DOT6 = 0x20; const DOT7 = 0x40; const DOT8 = 0x80;

// Five diagonals (top-left to bottom-right)
const D0 = 0x01;
const D1 = 0x0A;
const D2 = 0x14;
const D3 = 0x60;
const D4 = 0x80;
const ALL = D0 | D1 | D2 | D3 | D4;

// Rows (horizontal)
const ROW0 = DOT1 | DOT4;
const ROW1 = DOT2 | DOT5;
const ROW2 = DOT3 | DOT6;
const ROW3 = DOT7 | DOT8;

// Columns
const COL_L = DOT1 | DOT2 | DOT3 | DOT7;
const COL_R = DOT4 | DOT5 | DOT6 | DOT8;

// Corner pairs
const CORNERS_TLBR = DOT1 | DOT8;
const CORNERS_TRBL = DOT4 | DOT7;

function br(...masks: number[]): string {
  let bits = 0;
  for (const m of masks) bits |= m;
  return String.fromCharCode(0x2800 + bits);
}

// ---------------------------------------------------------------------------
// Frame type
// ---------------------------------------------------------------------------
interface Frame {
  char: string;
  tint: Tint;
  ms: number;
}

function f(char: string, tint: Tint, ms: number): Frame {
  return { char, tint, ms: Math.round(ms * TEMPO) };
}

// ---------------------------------------------------------------------------
// Easing helpers
// ---------------------------------------------------------------------------

/** Cosine ease-in-out durations: slow at edges, fast in the middle. */
function easedMs(n: number, slow: number, fast: number): number[] {
  return Array.from({ length: n }, (_, i) => {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const k = (1 + Math.cos(Math.PI * (2 * t - 1))) / 2;
    return Math.round(slow + (fast - slow) * k);
  });
}

/** Brightness curve: dim at edges, bright at center. */
function shimmerTints(n: number): Tint[] {
  return Array.from({ length: n }, (_, i) => {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const dist = Math.abs(2 * t - 1);
    if (dist < 0.3) return 'bright' as Tint;
    if (dist < 0.7) return 'mid' as Tint;
    return 'dim' as Tint;
  });
}

// ---------------------------------------------------------------------------
// Pattern builder helpers
// ---------------------------------------------------------------------------

const SWEEP_FWD = [
  [D0],          [D0, D1],       [D0, D1, D2],
  [D1, D2, D3],  [D2, D3, D4],  [D3, D4],       [D4],
];

const SWEEP_REV = [...SWEEP_FWD].reverse();

function sweep(
  masks: number[][],
  tint: Tint | 'shimmer',
  slow: number,
  fast: number,
): Frame[] {
  const durations = easedMs(masks.length, slow, fast);
  const tints = tint === 'shimmer'
    ? shimmerTints(masks.length)
    : Array<Tint>(masks.length).fill(tint);
  return masks.map((m, i) => f(br(...m), tints[i]!, durations[i]!));
}

// ---------------------------------------------------------------------------
// Pattern catalog (20 patterns)
// ---------------------------------------------------------------------------

type PatternFn = () => Frame[];

const PATTERNS: PatternFn[] = [
  // ---- Sweeps (5) ----
  () => sweep(SWEEP_FWD, 'shimmer', 280, 140),
  () => sweep(SWEEP_FWD, 'mid', 240, 130),
  () => sweep(SWEEP_REV, 'shimmer', 280, 140),
  () => sweep(SWEEP_REV, 'dim', 320, 200),
  () => sweep(SWEEP_FWD, 'bright', 220, 110),

  // ---- Pulses (4) ----
  () => [
    f(br(D2),              'dim',    220),
    f(br(D1, D2, D3),      'mid',    180),
    f(br(ALL),             'bright', 220),
    f(br(D1, D2, D3),      'mid',    180),
    f(br(D2),              'dim',    220),
  ],
  () => [
    f(br(D2),              'dim',    300),
    f(br(D1, D2, D3),      'dim',    240),
    f(br(ALL),             'mid',    200),
    f(br(ALL),             'bright', 320),
    f(br(ALL),             'mid',    200),
    f(br(D1, D2, D3),      'dim',    240),
    f(br(D2),              'dim',    300),
  ],
  () => [
    f(br(D2),              'mid',    130),
    f(br(D1, D2, D3),      'bright', 150),
    f(br(D2),              'dim',    250),
    f(br(D2),              'mid',    130),
    f(br(D1, D2, D3),      'bright', 150),
    f(br(D2),              'dim',    180),
  ],
  () => [
    f(br(D1, D2, D3),      'dim',    320),
    f(br(D1, D2, D3),      'mid',    280),
    f(br(D1, D2, D3),      'dim',    320),
  ],

  // ---- Shimmers (4) ----
  () => [
    f(br(D0, D2, D4),      'mid',    220),
    f(br(ALL),             'bright', 160),
    f(br(D1, D3),          'mid',    220),
    f(br(ALL),             'bright', 160),
    f(br(D0, D2, D4),      'mid',    200),
  ],
  () => [
    f(br(CORNERS_TLBR),    'dim',    260),
    f(br(CORNERS_TRBL),    'mid',    220),
    f(br(CORNERS_TLBR),    'mid',    220),
    f(br(CORNERS_TRBL),    'dim',    260),
  ],
  () => [
    f(br(COL_L),           'mid',    200),
    f(br(COL_L, COL_R),   'bright', 180),
    f(br(COL_R),           'mid',    200),
    f(br(COL_L, COL_R),   'bright', 180),
    f(br(COL_L),           'mid',    200),
  ],
  () => [
    f(br(D0, D4),          'dim',    260),
    f(br(D0, D1, D3, D4),  'mid',    200),
    f(br(ALL),             'bright', 240),
    f(br(D1, D2, D3),      'mid',    200),
    f(br(D2),              'dim',    280),
  ],

  // ---- Accents (3) ----
  () => [
    f(br(D2),              'mid',    100),
    f(br(ALL),             'bright', 130),
    f(br(D0, D1, D2, D3),  'mid',    200),
    f(br(D1, D2, D3),      'dim',    260),
    f(br(D2),              'dim',    300),
  ],
  () => [
    f(br(D2),              'dim',    120),
    f(br(D1, D2, D3),      'mid',    130),
    f(br(D2),              'dim',    200),
    f(br(D1, D2, D3),      'bright', 140),
    f(br(ALL),             'bright', 160),
    f(br(D1, D2, D3),      'mid',    180),
    f(br(D2),              'dim',    300),
  ],
  () => {
    const durations = easedMs(5, 280, 160);
    const tints: Tint[] = ['dim', 'mid', 'bright', 'mid', 'dim'];
    return [D0, D1, D2, D3, D4].map((d, i) =>
      f(br(d), tints[i]!, durations[i]!),
    );
  },

  // ---- Flows (4) ----
  () => {
    const masks = [
      [ROW0],          [ROW0, ROW1],    [ROW1, ROW2],
      [ROW2, ROW3],    [ROW3],
    ];
    const durations = easedMs(5, 260, 150);
    const tints: Tint[] = ['dim', 'mid', 'bright', 'mid', 'dim'];
    return masks.map((m, i) => f(br(...m), tints[i]!, durations[i]!));
  },
  () => [
    f(br(ROW3),                     'dim',    240),
    f(br(ROW2, ROW3),               'dim',    200),
    f(br(ROW1, ROW2, ROW3),         'mid',    180),
    f(br(ALL),                      'bright', 260),
    f(br(ROW1, ROW2, ROW3),         'mid',    180),
    f(br(ROW2, ROW3),               'dim',    200),
    f(br(ROW3),                     'dim',    240),
  ],
  () => {
    const path = [DOT1, DOT4, DOT5, DOT6, DOT8, DOT7, DOT3, DOT2];
    const durations = easedMs(8, 240, 140);
    return path.map((d, i) => f(br(d), 'mid', durations[i]!));
  },
  () => {
    const pairs = [
      [DOT1],          [DOT1, DOT4],  [DOT4, DOT2],
      [DOT2, DOT5],   [DOT5, DOT3],  [DOT3, DOT6],
      [DOT6, DOT7],   [DOT7, DOT8],  [DOT8],
    ];
    const durations = easedMs(9, 250, 130);
    const tints = shimmerTints(9);
    return pairs.map((p, i) => f(br(...p), tints[i]!, durations[i]!));
  },
];

// ---------------------------------------------------------------------------
// Braille pattern pause timing
// ---------------------------------------------------------------------------
const PATTERN_PAUSE_MIN_MS = 1000;
const PATTERN_PAUSE_MAX_MS = 2500;
const PATTERN_INITIAL_DELAY_MS = 150;

function randomPatternPause(): number {
  return PATTERN_PAUSE_MIN_MS + Math.floor(Math.random() * (PATTERN_PAUSE_MAX_MS - PATTERN_PAUSE_MIN_MS));
}

function pickPattern(lastIndex: number): number {
  if (PATTERNS.length <= 1) return 0;
  let idx: number;
  do {
    idx = Math.floor(Math.random() * PATTERNS.length);
  } while (idx === lastIndex);
  return idx;
}

// ---------------------------------------------------------------------------
// Message wave animation
// ---------------------------------------------------------------------------
// A subtle gray brightness wave that slowly rolls across the message text.
// Cosine bump profile: base gray at edges, slightly lighter at the peak.

const WAVE_BASE  = [0x6B, 0x72, 0x80] as const; // #6B7280 (muted gray)
const WAVE_PEAK  = [0x90, 0x97, 0xA5] as const; // #9097A5 (lighter gray)
const WAVE_WIDTH = 4;                             // half-width in characters

// Timing for the wave crawl (eased: slow at edges, faster in middle)
const WAVE_STEP_SLOW_MS = 200;
const WAVE_STEP_FAST_MS = 100;

// Pauses between wave cycles
const WAVE_PAUSE_MIN_MS = 5000;
const WAVE_PAUSE_MAX_MS = 12000;
const WAVE_END_PAUSE_MS = 800; // brief pause at far side before reversing

const MUTED = chalk.hex('#6B7280');

// Working tag subtitle colors (step-dimmed fade)
const WORKING_NORMAL = chalk.hex('#4B5563');
const WORKING_DIM    = chalk.hex('#374151');
const WORKING_FAINT  = chalk.hex('#1F2937');
const WORKING_COLORS = [WORKING_NORMAL, WORKING_DIM, WORKING_FAINT] as const;

// Fade schedule: [delay in ms before advancing to next stage]
// Stage 0 = normal, 1 = dim, 2 = faint, 3 = removed
const WORKING_FADE_DELAYS = [8000, 1000, 1000] as const;

function randomWavePause(): number {
  return WAVE_PAUSE_MIN_MS + Math.floor(Math.random() * (WAVE_PAUSE_MAX_MS - WAVE_PAUSE_MIN_MS));
}

// ---------------------------------------------------------------------------
// StatusSpinner component
// ---------------------------------------------------------------------------

export class StatusSpinner extends Text {
  // Braille pattern state
  private patternTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPatternIndex = -1;
  private spinnerChar = '\u2800';
  private spinnerTint: Tint = 'dim';

  // Wave state
  private waveTimer: ReturnType<typeof setTimeout> | null = null;
  private wavePos = 0;
  private waveActive = false;

  // Elapsed timer
  private startTime = Date.now();
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;

  // Working tag queue (completed messages revealed word-by-word)
  private workingQueue: string[] = [];
  private workingWords: string[] = [];   // words of the current message
  private workingRevealed = 0;           // how many words are visible
  private workingDisplay = '';           // the visible text (built from revealed words)
  private workingFadeStage = -1;         // -1 = active, 0-2 = fading stages
  private workingTimer: ReturnType<typeof setTimeout> | null = null;

  private stopped = false;

  constructor(
    private readonly tui: TUI,
    private readonly message: string,
  ) {
    super('', 1, 0);
    this.compose();

    // Start the braille pattern loop
    this.patternTimer = setTimeout(() => this.schedulePattern(), PATTERN_INITIAL_DELAY_MS);
    // Start the wave loop (first wave after a long random pause)
    this.waveTimer = setTimeout(() => this.startWaveCycle(), randomWavePause());
    // Tick the elapsed counter every second
    this.elapsedTimer = setInterval(() => this.compose(), 1000);
  }

  stop(): void {
    this.stopped = true;
    if (this.patternTimer) { clearTimeout(this.patternTimer); this.patternTimer = null; }
    if (this.waveTimer) { clearTimeout(this.waveTimer); this.waveTimer = null; }
    if (this.elapsedTimer) { clearInterval(this.elapsedTimer); this.elapsedTimer = null; }
    if (this.workingTimer) { clearTimeout(this.workingTimer); this.workingTimer = null; }
  }

  // -------------------------------------------------------------------------
  // Shared render
  // -------------------------------------------------------------------------

  private compose(): void {
    if (this.stopped) return;

    const spinner = TINT[this.spinnerTint](this.spinnerChar);
    const msg = this.waveActive
      ? this.renderWaveMessage()
      : MUTED(this.message);
    const elapsed = this.formatElapsed();

    let line = `${spinner} ${msg}  ${MUTED(elapsed)}`;

    // Append working tag text inline if present
    if (this.workingDisplay) {
      const colorFn = this.workingFadeStage >= 0
        ? (WORKING_COLORS[this.workingFadeStage] ?? WORKING_FAINT)
        : WORKING_NORMAL;

      // Calculate available space: terminal width minus the fixed prefix
      // prefix = 1 (spinner) + 1 (space) + message.length + 2 (spaces) + elapsed.length + 3 (separator)
      const prefixLen = 1 + 1 + this.message.length + 2 + elapsed.length + 3;
      const termWidth = process.stdout.columns || 80;
      const available = termWidth - prefixLen - 2; // 2 for right margin

      if (available > 5) {
        const cleaned = this.workingDisplay.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
        const display = cleaned.length > available
          ? '\u2026' + cleaned.slice(-(available - 1))
          : cleaned;
        line += `   ${colorFn(display)}`;
      }
    }

    this.setText(line);
    this.tui.requestRender();
  }

  // -------------------------------------------------------------------------
  // Elapsed timer
  // -------------------------------------------------------------------------

  private formatElapsed(): string {
    const totalSec = Math.floor((Date.now() - this.startTime) / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    if (min > 0) {
      return `${min}m ${sec.toString().padStart(2, '0')}s`;
    }
    return `${sec}s`;
  }

  // -------------------------------------------------------------------------
  // Wave animation
  // -------------------------------------------------------------------------

  private renderWaveMessage(): string {
    let result = '';
    for (let i = 0; i < this.message.length; i++) {
      const dist = Math.abs(i - this.wavePos);
      let influence = 0;
      if (dist < WAVE_WIDTH) {
        // Smooth cosine bump: 1 at center, 0 at edges
        influence = (1 + Math.cos(Math.PI * dist / WAVE_WIDTH)) / 2;
      }
      const r = Math.round(WAVE_BASE[0] + (WAVE_PEAK[0] - WAVE_BASE[0]) * influence);
      const g = Math.round(WAVE_BASE[1] + (WAVE_PEAK[1] - WAVE_BASE[1]) * influence);
      const b = Math.round(WAVE_BASE[2] + (WAVE_PEAK[2] - WAVE_BASE[2]) * influence);
      result += chalk.rgb(r, g, b)(this.message[i]!);
    }
    return result;
  }

  /** Run one full LTR + RTL wave cycle, then schedule the next pause. */
  private startWaveCycle(): void {
    if (this.stopped) return;
    this.runWave(1, () => {
      // Brief pause at the far end, then reverse
      this.waveTimer = setTimeout(() => {
        this.runWave(-1, () => {
          // Cycle complete, schedule next long pause
          this.waveActive = false;
          this.compose();
          this.waveTimer = setTimeout(() => this.startWaveCycle(), randomWavePause());
        });
      }, WAVE_END_PAUSE_MS);
    });
  }

  /** Animate the wave in one direction. direction: 1 = LTR, -1 = RTL. */
  private runWave(direction: 1 | -1, onComplete: () => void): void {
    const len = this.message.length;
    const start = direction === 1 ? -WAVE_WIDTH : len + WAVE_WIDTH;
    const end   = direction === 1 ? len + WAVE_WIDTH : -WAVE_WIDTH;
    const totalSteps = len + 2 * WAVE_WIDTH;
    const durations = easedMs(totalSteps, WAVE_STEP_SLOW_MS, WAVE_STEP_FAST_MS);

    this.waveActive = true;

    const step = (i: number) => {
      if (this.stopped) return;
      if (i >= totalSteps) {
        this.waveActive = false;
        this.compose();
        onComplete();
        return;
      }

      this.wavePos = start + direction * i;
      this.compose();
      this.waveTimer = setTimeout(() => step(i + 1), durations[i]!);
    };

    step(0);
  }

  // -------------------------------------------------------------------------
  // Braille pattern animation
  // -------------------------------------------------------------------------

  private schedulePattern(): void {
    if (this.stopped) return;
    const idx = pickPattern(this.lastPatternIndex);
    this.lastPatternIndex = idx;
    this.playPatternFrames(PATTERNS[idx]!(), 0);
  }

  private playPatternFrames(frames: Frame[], i: number): void {
    if (this.stopped) return;

    if (i >= frames.length) {
      // Resting state
      this.spinnerChar = '\u2800';
      this.spinnerTint = 'dim';
      this.compose();
      this.patternTimer = setTimeout(() => this.schedulePattern(), randomPatternPause());
      return;
    }

    const frame = frames[i]!;
    this.spinnerChar = frame.char;
    this.spinnerTint = frame.tint;
    this.compose();
    this.patternTimer = setTimeout(() => this.playPatternFrames(frames, i + 1), frame.ms);
  }

  // -------------------------------------------------------------------------
  // Working tag queue (word-by-word reveal at reading pace)
  // -------------------------------------------------------------------------

  private static readonly WORD_REVEAL_MS = 200;  // ms per word (~300 WPM)
  private static readonly HOLD_AFTER_REVEAL_MS = 1500; // pause after full reveal

  /** Enqueue a completed working tag message for word-by-word display. */
  enqueueWorkingText(text: string): void {
    const cleaned = text.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!cleaned) return;

    this.workingQueue.push(cleaned);

    // If nothing is currently being revealed, start the queue
    if (!this.workingDisplay && this.workingWords.length === 0) {
      this.advanceQueue();
    }
  }

  /** Immediately clear the queue, display, and all timers. */
  clearWorkingQueue(): void {
    if (this.workingTimer) {
      clearTimeout(this.workingTimer);
      this.workingTimer = null;
    }
    this.workingQueue.length = 0;
    this.workingWords.length = 0;
    this.workingRevealed = 0;
    this.workingDisplay = '';
    this.workingFadeStage = -1;
    this.compose();
  }

  /** Start revealing the next queued message, or fade if queue is empty. */
  private advanceQueue(): void {
    if (this.workingTimer) {
      clearTimeout(this.workingTimer);
      this.workingTimer = null;
    }

    const next = this.workingQueue.shift();
    if (next) {
      this.workingWords = next.split(/\s+/);
      this.workingRevealed = 0;
      this.workingFadeStage = -1;
      this.revealNextWord();
    } else if (this.workingDisplay) {
      // Queue empty: fade the last displayed message
      this.workingFadeStage = 0;
      this.compose();
      this.scheduleFadeStep();
    }
  }

  /** Reveal one more word, then schedule the next (or hold after full reveal). */
  private revealNextWord(): void {
    if (this.stopped) return;

    if (this.workingRevealed < this.workingWords.length) {
      this.workingRevealed++;
      this.workingDisplay = this.workingWords.slice(0, this.workingRevealed).join(' ');
      this.compose();

      this.workingTimer = setTimeout(
        () => { this.workingTimer = null; this.revealNextWord(); },
        StatusSpinner.WORD_REVEAL_MS,
      );
    } else {
      // All words revealed: hold briefly, then advance
      this.workingTimer = setTimeout(
        () => { this.workingTimer = null; this.advanceQueue(); },
        StatusSpinner.HOLD_AFTER_REVEAL_MS,
      );
    }
  }

  private scheduleFadeStep(): void {
    if (this.workingFadeStage < 0 || this.workingFadeStage >= WORKING_FADE_DELAYS.length) {
      this.workingDisplay = '';
      this.workingFadeStage = -1;
      this.workingWords.length = 0;
      this.workingRevealed = 0;
      this.compose();
      return;
    }

    const delay = WORKING_FADE_DELAYS[this.workingFadeStage]!;
    this.workingTimer = setTimeout(() => {
      this.workingTimer = null;
      this.workingFadeStage++;

      if (this.workingFadeStage >= WORKING_COLORS.length) {
        this.workingDisplay = '';
        this.workingFadeStage = -1;
        this.workingWords.length = 0;
        this.workingRevealed = 0;
        this.compose();
      } else {
        this.compose();
        this.scheduleFadeStep();
      }
    }, delay);
  }
}
