/**
 * The page's only behaviour.
 *
 * Deliberately tiny. A landing page does not need a framework, and every line
 * here is something a reader would notice if it were missing.
 *
 * The system colour scheme is the default; this adds an explicit override that
 * survives navigation and can be flipped back.
 */

const STORAGE_KEY = 'mark-theme';

const toggle = document.getElementById('theme-toggle');
const root = document.documentElement();

/** Read the stored preference, falling back to the system setting. */
function storedTheme() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private browsing can make localStorage throw. The system scheme is a
    // perfectly good fallback, so this must not be fatal.
    return null;
  }
}

function apply(theme) {
  const dark = theme === 'dark';
  root.style.colorScheme = dark ? 'dark' : 'light';
  toggle?.setAttribute('aria-pressed', String(dark));
  if (toggle) {
    toggle.setAttribute(
      'aria-label',
      dark ? '切换为浅色模式' : '切换为深色模式',
    );
  }
}

apply(storedTheme() ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

toggle?.addEventListener('click', () => {
  const isDark = root.style.colorScheme === 'dark';
  const next = isDark ? 'light' : 'dark';
  apply(next);
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* preference simply will not persist */
  }
});

/**
 * Mark the section currently on screen in the nav.
 *
 * `IntersectionObserver` rather than a scroll handler: the browser does the work
 * off the main thread, so scrolling stays smooth on a phone.
 */
const links = [...document.querySelectorAll('.nav-links a')];
const sections = links
  .map((a) => document.querySelector(a.getAttribute('href') ?? ''))
  .filter((el) => el !== null);

if (sections.length > 0 && 'IntersectionObserver' in window) {
  const seen = new Map();

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) seen.set(entry.target.id, entry.isIntersecting ? entry.intersectionRatio : 0);

      let bestId = null;
      let bestRatio = 0;
      for (const [id, ratio] of seen) {
        if (ratio > bestRatio) {
          bestRatio = ratio;
          bestId = id;
        }
      }

      for (const a of links) {
        const active = a.getAttribute('href') === `#${bestId}`;
        a.style.color = active ? 'var(--ink)' : '';
        a.style.borderBottomColor = active ? 'var(--accent)' : 'transparent';
      }
    },
    // A band across the upper third: a section counts as "current" once its top
    // has passed the nav rather than the instant it first appears.
    { rootMargin: '-20% 0px -70% 0px', threshold: [0, 0.25, 0.5, 1] },
  );

  for (const section of sections) observer.observe(section);
}