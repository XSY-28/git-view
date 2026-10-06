import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { preferencesSchema, type Language } from '@git-view/contracts';
import { api } from '../state/api';
import { translate } from './translate';

interface I18nState {
  language: Language;
  locale: Language;
  t: (message: string | undefined, values?: readonly (string | number)[]) => string;
  loadLanguage: () => Promise<void>;
  changeLanguage: (language: Language) => Promise<void>;
  ready: boolean;
  saving: boolean;
  error?: string;
}
const I18nContext = createContext<I18nState | undefined>(undefined);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>('en');
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef(false);
  const loadLanguage = useCallback(async () => {
    try {
      const result = await api({ schemaVersion: 1, action: 'preferences', requestId: crypto.randomUUID() }, preferencesSchema);
      setLanguage(result.data.language);
      setError(undefined);
    } catch { setError('无法读取语言设置，请重试。'); }
    finally { setReady(true); }
  }, []);
  const changeLanguage = useCallback(async (next: Language) => {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setError(undefined);
    try {
      // Apply only after the host confirms the atomic file write. A failed save
      // must not look like a preference that will survive the next launch.
      const result = await api({ schemaVersion: 1, action: 'set-language', language: next, requestId: crypto.randomUUID() }, preferencesSchema);
      setLanguage(result.data.language);
    } catch { setError('无法保存语言设置，请重试。'); }
    finally { pending.current = false; setSaving(false); }
  }, []);
  useEffect(() => {
    document.documentElement.lang = language;
    document.title = language === 'en' ? 'Git View' : 'Git 变化视图';
  }, [language]);
  return <I18nContext.Provider value={{ language, locale: language, t: (message, values) => translate(message ?? '', language, values), loadLanguage, changeLanguage, ready, saving, error }}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) throw new Error('I18nProvider is required');
  return context;
}

export function LanguageSelector() {
  const { language, t, ready, saving, error, changeLanguage } = useI18n();
  return <div className="language-setting">
    <label className="sr-only" htmlFor="app-language">{t('界面语言')}</label>
    <select id="app-language" className="language-selector" value={language} disabled={!ready || saving} aria-busy={saving} onChange={event => { const next = event.target.value; if (next === 'en' || next === 'zh-CN') void changeLanguage(next); }}>
      <option value="en" lang="en">English</option><option value="zh-CN" lang="zh-CN">中文</option>
    </select>
    {error && <span className="language-error" role="alert">{t(error)}</span>}
  </div>;
}
