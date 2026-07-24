import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en';
import frCA from './frCA';
import es from './es';

export const LOCALES = [
  { id: 'en', label: 'English' },
  { id: 'fr-CA', label: 'Français' },
  { id: 'es', label: 'Español' },
] as const;

export type LocaleId = (typeof LOCALES)[number]['id'];

function detectInitial(): LocaleId {
  const saved = localStorage.getItem('gb.lang') as LocaleId | null;
  if (saved && LOCALES.some((l) => l.id === saved)) return saved;
  const nav = navigator.language.toLowerCase();
  if (nav.startsWith('fr')) return 'fr-CA';
  if (nav.startsWith('es')) return 'es';
  return 'en';
}

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    'fr-CA': { translation: frCA },
    es: { translation: es },
  },
  lng: detectInitial(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  returnEmptyString: false,
});

export function setLocale(id: LocaleId) {
  localStorage.setItem('gb.lang', id);
  i18n.changeLanguage(id);
  document.documentElement.lang = id;
}

document.documentElement.lang = i18n.language;

export default i18n;
