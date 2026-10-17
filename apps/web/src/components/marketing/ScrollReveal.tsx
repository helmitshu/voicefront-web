'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

/**
 * Scroll reveals for the marketing pages: sections fade up gently as
 * they approach the viewport, once each. Mounted once by the marketing
 * layout and re-run per route, since the layout itself persists across
 * client-side navigations between marketing pages.
 *
 * The safety contract is the point: content is never hidden by markup
 * or CSS alone. Sections start fully visible; this effect adds the
 * pre-state itself, only to sections still below the fold at the moment
 * it runs, and only when motion is welcome (no prefers-reduced-motion,
 * no calm mode, IntersectionObserver present). First-paint content is
 * never touched, a print of the page is guarded in globals.css, and
 * once a section has revealed, both classes come back off so the
 * element returns to its natural styles.
 */
export function ScrollReveal() {
  const pathname = usePathname();

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (document.documentElement.dataset.calm === 'true') return;
    if (!('IntersectionObserver' in window)) return;
    const main = document.querySelector('main');
    if (!main) return;
    const sections = Array.from(main.querySelectorAll<HTMLElement>('section'));
    if (sections.length === 0) return;

    const touched = new Set<HTMLElement>();
    const settleTimers = new Set<number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target as HTMLElement;
          observer.unobserve(el);
          // Two frames so the pre-state paints before the transition to
          // the in-state begins; without them the reveal can snap.
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              el.classList.add('vf-reveal-in');
              // Once the transition has run, strip both classes: the
              // section keeps no transform or opacity of ours behind.
              const timer = window.setTimeout(() => {
                settleTimers.delete(timer);
                el.classList.remove('vf-reveal-pre', 'vf-reveal-in');
                touched.delete(el);
              }, 800);
              settleTimers.add(timer);
            });
          });
        }
      },
      { threshold: 0.08, rootMargin: '0px 0px -6% 0px' },
    );

    for (const el of sections) {
      // At or near first paint (in view, or just about to be scrolled
      // to): leave it exactly as authored. Only genuinely below-fold
      // sections earn the pre-state, so nothing the visitor can already
      // see ever flashes or hides.
      if (el.getBoundingClientRect().top < window.innerHeight * 0.95) continue;
      el.classList.add('vf-reveal-pre');
      touched.add(el);
      observer.observe(el);
    }

    return () => {
      observer.disconnect();
      for (const timer of settleTimers) window.clearTimeout(timer);
      for (const el of touched) el.classList.remove('vf-reveal-pre', 'vf-reveal-in');
    };
  }, [pathname]);

  return null;
}
