/**
 * Cruzo — Frosted Glass Box Hover Interaction
 * Dynamic specular spotlight and glass illumination following the normal cursor across boxes.
 */

(function () {
  const boxSelector = '.card, .gateway-card, .acoustic-hero-card, .audio-deck, .modal-card, .clapper-box, .scanner-card, .guide-step';

  function attachGlassHover(el) {
    if (el._hasGlassHover) return;
    el._hasGlassHover = true;

    el.addEventListener('mousemove', (e) => {
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      el.style.setProperty('--mouse-x', `${x}px`);
      el.style.setProperty('--mouse-y', `${y}px`);
    }, { passive: true });
  }

  function initGlassHover() {
    document.querySelectorAll(boxSelector).forEach(attachGlassHover);

    // Event delegation for dynamically added or rendered cards
    document.addEventListener('mouseover', (e) => {
      const box = e.target.closest(boxSelector);
      if (box && !box._hasGlassHover) {
        attachGlassHover(box);
      }
    }, { passive: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initGlassHover);
  } else {
    initGlassHover();
  }
})();
