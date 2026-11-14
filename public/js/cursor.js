/**
 * Cruzo — Apple Frosted Glass Cursor Controller
 * Smooth magnetic fluid cursor with backdrop blur and spring dynamics.
 * Automatically disabled on touch / mobile devices.
 */

(function () {
  // Only initialize on desktop devices with mouse / fine pointer
  if (!window.matchMedia || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    return;
  }

  let mouseX = -100;
  let mouseY = -100;
  let ringX = -100;
  let ringY = -100;
  let isHovering = false;
  let isActive = false;
  let isVisible = false;
  let rafId = null;

  // Create cursor DOM elements
  const dot = document.createElement('div');
  dot.className = 'glass-cursor-dot glass-cursor-hidden';

  const ring = document.createElement('div');
  ring.className = 'glass-cursor-ring glass-cursor-hidden';

  document.body.appendChild(ring);
  document.body.appendChild(dot);

  function lerp(start, end, factor) {
    return start + (end - start) * factor;
  }

  function updateCursor() {
    // Smooth trailing physics for the frosted ring
    ringX = lerp(ringX, mouseX, 0.22);
    ringY = lerp(ringY, mouseY, 0.22);

    dot.style.transform = `translate3d(${mouseX}px, ${mouseY}px, 0) translate(-50%, -50%)`;
    ring.style.transform = `translate3d(${ringX}px, ${ringY}px, 0) translate(-50%, -50%)`;

    rafId = requestAnimationFrame(updateCursor);
  }

  window.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;

    if (!isVisible) {
      isVisible = true;
      dot.classList.remove('glass-cursor-hidden');
      ring.classList.remove('glass-cursor-hidden');
      ringX = mouseX;
      ringY = mouseY;
    }
  });

  window.addEventListener('mousedown', () => {
    isActive = true;
    ring.classList.add('active');
  });

  window.addEventListener('mouseup', () => {
    isActive = false;
    ring.classList.remove('active');
  });

  document.addEventListener('mouseleave', () => {
    isVisible = false;
    dot.classList.add('glass-cursor-hidden');
    ring.classList.add('glass-cursor-hidden');
  });

  document.addEventListener('mouseenter', () => {
    isVisible = true;
    dot.classList.remove('glass-cursor-hidden');
    ring.classList.remove('glass-cursor-hidden');
  });

  // Track interactive hover elements
  const interactiveSelector = 'a, button, input, [role="button"], .gateway-card, .btn-preset, .btn-fine, .btn-theme-toggle, .nav-btn-guide, .clapper-box, .modal-close-btn';

  document.addEventListener('mouseover', (e) => {
    const target = e.target.closest(interactiveSelector);
    if (target && !isHovering) {
      isHovering = true;
      ring.classList.add('hovering');
    }
  });

  document.addEventListener('mouseout', (e) => {
    const target = e.target.closest(interactiveSelector);
    if (target && isHovering) {
      // Check if we didn't just move to another child of the same interactive element
      if (!e.relatedTarget || !e.relatedTarget.closest(interactiveSelector)) {
        isHovering = false;
        ring.classList.remove('hovering');
      }
    }
  });

  rafId = requestAnimationFrame(updateCursor);
})();
