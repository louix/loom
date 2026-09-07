/**
 * The one animation clock, and the one deadline timer.
 *
 * There is a single beat for the whole UI rather than a timer per animated
 * widget: several timers would drift apart, and a spinner that repaints on its
 * own schedule costs a frame each time regardless of what else changed.
 *
 * What is new is that the beat is *scoped to what is on screen*. The old
 * 120ms interval ran for the life of the process and asked "is anything in the
 * fleet busy" — so a session spinning in a row scrolled out of the list, or in
 * the pane the layout is not showing, still bought a repaint every 120ms. It
 * also polled for a notice to expire, four beats per second, forever.
 *
 * Two rates, because two kinds of content move: a spinner has to advance
 * several times a second to read as motion, while an elapsed second or a cache
 * countdown is drawn at whole-second resolution and beating faster than that
 * would repaint identical text.
 */

/** What the current frame needs, coarsest last. `null` is a still frame. */
export type Beat = "spin" | "age" | null;

/** Spinner phase. Ink's own frame cap is 30fps; this is the animation, not the
 *  render budget. */
export const SPIN_MS = 120;
/** Elapsed seconds, cache countdowns, rate-limit resets. Also the resolution
 *  the frame's `now` is coarsened to. */
export const AGE_MS = 1000;

export interface ClockDeps {
  /** What the frame that was just published needs. Read after every publish. */
  needs: () => Beat;
  /** Advance the phase and repaint. */
  beat: () => void;
}

export interface Clock {
  /** Re-read {@link ClockDeps.needs} and start, stop or re-rate accordingly. */
  settle: () => void;
  dispose: () => void;
}

export const mkClock = ({ needs, beat }: ClockDeps): Clock => {
  let running: Beat = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    running = null;
  };

  return {
    settle: () => {
      const want = needs();
      // Re-arming an interval at the same rate would reset its phase, so a
      // steady stream of publishes could starve the spinner of a single beat.
      if (want === running) return;
      stop();
      if (want === null) return;
      running = want;
      timer = setInterval(beat, want === "spin" ? SPIN_MS : AGE_MS);
    },
    dispose: stop,
  };
};

export interface Deadline {
  /** Fire in `ms`, replacing whatever was pending. `null` cancels. */
  at: (ms: number | null) => void;
  dispose: () => void;
}

/**
 * A one-shot timer at a moving deadline — for the things that happen *once*, at
 * a known time, rather than repeatedly: a notice expiring. Polling for those on
 * an interval is what kept the old clock running through an idle UI.
 */
export const mkDeadline = (fire: () => void): Deadline => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return {
    at: (ms) => {
      clear();
      if (ms === null) return;
      timer = setTimeout(
        () => {
          timer = null;
          fire();
        },
        Math.max(0, ms),
      );
    },
    dispose: clear,
  };
};
