import type { ReactNode } from 'react'

/* Trilingual leaf: every language renders into the DOM; CSS on
   :root[data-lang=…] shows one. This is deliberate (inherited from v1):
   the language toggle keeps working before hydration and with JS disabled
   after the initial paint, and switching is instant with zero re-render
   of a 10k-word page. Language/theme setters live in lib/prefs.ts.

   `nl` is optional — the Dutch translation (contributed by @thomasboom
   against the old single-file version) is being ported progressively; a
   leaf without `nl` falls back to English, so the NL toggle is honest
   about its beta state without ever showing a hole.

   Each leaf carries its own lang attribute: whatever the page language,
   any fragment a screen reader encounters is pronounced with the right
   rules (WCAG 3.1.2 language-of-parts). */
export function T({ fr, en, nl }: { fr: ReactNode; en: ReactNode; nl?: ReactNode }) {
  return (
    <>
      <span data-l="fr" lang="fr">
        {fr}
      </span>
      <span data-l="en" lang="en">
        {en}
      </span>
      <span data-l="nl" lang={nl != null ? 'nl' : 'en'}>
        {nl ?? en}
      </span>
    </>
  )
}
