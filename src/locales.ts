// The languages the in-chat widgets are translated into (set_language), with
// each language's own name. Pure data: safe to import from anywhere.

/** Non-English site locales, in the order the language switcher lists them. */
export const LOCALES = [
    "de",
    "es",
    "fr",
    "nl",
    "pl",
    "it",
    "uk",
    "ja",
    "tr",
] as const;
export type Locale = (typeof LOCALES)[number];

/** English plus every translated locale — every language the widgets ship in. */
export type SiteLocale = "en" | Locale;
export const SITE_LOCALES: readonly SiteLocale[] = ["en", ...LOCALES];

/** Each locale's own name for itself, for the language picker. */
export const LOCALE_NAMES: Record<SiteLocale, string> = {
    en: "English",
    de: "Deutsch",
    es: "Español",
    fr: "Français",
    nl: "Nederlands",
    pl: "Polski",
    it: "Italiano",
    uk: "Українська",
    ja: "日本語",
    tr: "Türkçe",
};
