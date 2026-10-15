'use client';

import { useEffect, type ReactNode } from 'react';

interface MobileDrawerProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name for the dialog ("Main" / "Admin"). */
  label: string;
  /** Theme surface classes for the panel (matches the desktop sidebar). */
  panelClassName: string;
  children: ReactNode;
}

/**
 * The small-screen slide-in drawer that replaces the old horizontal nav
 * strip. Always mounted so both directions animate: the panel slides with a
 * transform transition and the backdrop fades, and the wrapper drops pointer
 * events while closed. Backdrop tap, Escape, choosing a destination (the
 * shell closes it on navigation), or growing the viewport to desktop width
 * all close it — and body scroll is locked while it is open so the page
 * behind never moves.
 */
export function MobileDrawer({ open, onClose, label, panelClassName, children }: MobileDrawerProps) {
  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    function onResize() {
      // Tailwind's `md` breakpoint: at desktop width the sidebar takes over.
      if (window.innerWidth >= 768) onClose();
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onResize);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);
    };
  }, [open, onClose]);

  return (
    <div className={`fixed inset-0 z-50 md:hidden ${open ? '' : 'pointer-events-none'}`} aria-hidden={!open}>
      <div
        aria-hidden
        onClick={onClose}
        className={`absolute inset-0 bg-[rgba(3,12,9,0.5)] transition-opacity duration-300 ${
          open ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`absolute inset-y-0 left-0 flex w-[288px] max-w-[85vw] flex-col px-5 pb-4 pt-[22px] shadow-[30px_0_60px_rgba(0,0,0,0.35)] transition-transform duration-[380ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] ${
          open ? 'translate-x-0' : '-translate-x-full'
        } ${panelClassName}`}
      >
        {children}
      </div>
    </div>
  );
}
