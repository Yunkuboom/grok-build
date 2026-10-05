import { useEffect, useState } from 'react';

export type Lang = 'zh' | 'en';
export type LocalePref = 'system' | Lang;

let current: Lang = systemLang();
const listeners = new Set<() => void>();

export function systemLang(): Lang {
  const list = typeof navigator === 'undefined'
    ? []
    : (navigator.languages?.length ? navigator.languages : [navigator.language]);
  return list.some((tag) => String(tag || '').toLowerCase().startsWith('zh')) ? 'zh' : 'en';
}

export function resolveLang(pref: string | undefined | null): Lang {
  if (pref === 'zh' || pref === 'en') return pref;
  return systemLang();
}

export function currentLang(): Lang {
  return current;
}

/** Plain translator. Safe outside React; components re-render via useI18n. */
export function t(zh: string, en: string): string {
  return current === 'en' ? en : zh;
}

export function applyLocalePref(pref: string | undefined | null): Lang {
  const next = resolveLang(pref);
  const changed = next !== current;
  current = next;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en';
  }
  if (changed) listeners.forEach((fn) => fn());
  return next;
}

export function useI18n() {
  const [lang, setLang] = useState(current);
  useEffect(() => {
    const fn = () => setLang(current);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return { lang, t };
}
