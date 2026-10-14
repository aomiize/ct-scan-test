'use client';

import { useSyncExternalStore } from 'react';

export type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS';
export interface LogLine {
  t: string;
  level: Level;
  tag: string;
  msg: string;
  origin: 'browser' | 'server';
}

let lines: LogLine[] = [];
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

/** Browser-side session log: file loads, requests, timings. Server run logs are merged in by the Run Log tab. */
export const sessionLog = {
  add(level: Level, tag: string, msg: string) {
    lines = [...lines.slice(-999), { t: new Date().toISOString(), level, tag, msg, origin: 'browser' }];
    emit();
  },
  clear() {
    lines = [];
    emit();
  },
  subscribe(f: () => void) {
    subs.add(f);
    return () => subs.delete(f);
  },
  get: () => lines,
};

const empty: LogLine[] = [];
export function useSessionLog() {
  return useSyncExternalStore(sessionLog.subscribe, sessionLog.get, () => empty);
}
