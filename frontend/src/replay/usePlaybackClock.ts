/**
 * Race Replay — playback clock.
 *
 * The clock's time lives in a ref and advances on requestAnimationFrame. Per-frame consumers
 * (car positions, the HUD readouts) `subscribe` and update the DOM directly; React state is
 * refreshed only a few times a second (`time`), which is all the timing tower and timeline
 * need. Re-rendering the page every frame — as TelemetryPage's single-lap player does — would
 * not keep up with twenty cars at 50×.
 *
 * Keyed per replay: mount it under a component with `key={sessionKey}` so a new race starts
 * a fresh clock rather than resetting this one.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface PlaybackClock {
  /** Session time, refreshed ~`uiHz` times a second while playing and on every seek. */
  time: number;
  playing: boolean;
  speed: number;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  setSpeed: (speed: number) => void;
  seek: (t: number) => void;
  /** Seek relative to the current time. */
  nudge: (dt: number) => void;
  /** Called every animation frame while playing, on every seek, and once immediately. */
  subscribe: (cb: (t: number) => void) => () => void;
}

export interface ClockOptions {
  tMin: number;
  tMax: number;
  initial?: number;
  initialSpeed?: number;
  autoplay?: boolean;
  /** [from, to) ranges playback jumps over, e.g. red-flag stoppages. */
  skips?: [number, number][];
  uiHz?: number;
}

export const PLAYBACK_SPEEDS = [1, 2, 5, 10, 20, 50, 100];

const NO_SKIPS: [number, number][] = [];

/** A hidden tab pauses rAF; never advance more than this much wall time in one frame. */
const MAX_FRAME_S = 0.25;

export function usePlaybackClock({
  tMin,
  tMax,
  initial = tMin,
  initialSpeed = 1,
  autoplay = false,
  skips = NO_SKIPS,
  uiHz = 4,
}: ClockOptions): PlaybackClock {
  const timeRef = useRef(initial);
  const speedRef = useRef(initialSpeed);
  const skipsRef = useRef(skips);
  const listenersRef = useRef<Set<(t: number) => void>>(new Set());
  const [time, setTime] = useState(initial);
  const [playing, setPlaying] = useState(autoplay);
  const [speed, setSpeedState] = useState(initialSpeed);

  useEffect(() => {
    skipsRef.current = skips;
  }, [skips]);

  const emit = useCallback((t: number) => {
    listenersRef.current.forEach(cb => cb(t));
  }, []);

  const seek = useCallback(
    (t: number) => {
      const clamped = Math.min(Math.max(t, tMin), tMax);
      timeRef.current = clamped;
      emit(clamped);
      setTime(clamped);
    },
    [tMin, tMax, emit]
  );

  const nudge = useCallback((dt: number) => seek(timeRef.current + dt), [seek]);

  const play = useCallback(() => {
    if (timeRef.current >= tMax) seek(tMin);
    setPlaying(true);
  }, [tMin, tMax, seek]);

  const pause = useCallback(() => {
    setPlaying(false);
    setTime(timeRef.current);
  }, []);

  const toggle = useCallback(() => {
    if (playing) pause();
    else play();
  }, [playing, play, pause]);

  const setSpeed = useCallback((s: number) => {
    speedRef.current = s;
    setSpeedState(s);
  }, []);

  const subscribe = useCallback((cb: (t: number) => void) => {
    const listeners = listenersRef.current;
    listeners.add(cb);
    cb(timeRef.current);
    return () => {
      listeners.delete(cb);
    };
  }, []);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let lastUi = last;

    const step = (now: number) => {
      const dt = Math.min((now - last) / 1000, MAX_FRAME_S);
      last = now;
      let t = timeRef.current + dt * speedRef.current;
      for (const [a, b] of skipsRef.current) {
        if (t >= a && t < b) t = b;
      }

      const ended = t >= tMax;
      if (ended) t = tMax;

      timeRef.current = t;
      emit(t);
      if (ended) {
        setTime(t);
        setPlaying(false);
        return;
      }
      if (now - lastUi >= 1000 / uiHz) {
        lastUi = now;
        setTime(t);
      }
      raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, tMax, uiHz, emit]);

  return useMemo(
    () => ({ time, playing, speed, play, pause, toggle, setSpeed, seek, nudge, subscribe }),
    [time, playing, speed, play, pause, toggle, setSpeed, seek, nudge, subscribe]
  );
}
