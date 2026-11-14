/**
 * Cruzo — How to Use Frosted Glass Guide Modal Controller
 */

(function () {
  function initGuideModal() {
    const btnHowToUse = document.getElementById('btnHowToUse');
    const modal = document.getElementById('howToUseModal');
    const closeBtn = document.getElementById('modalCloseBtn');
    const gotItBtn = document.getElementById('modalGotItBtn');

    if (!modal) return;

    function openModal() {
      modal.classList.add('open');
      if (btnHowToUse) {
        btnHowToUse.setAttribute('aria-expanded', 'true');
      }
      document.body.style.overflow = 'hidden';
      if (closeBtn) {
        closeBtn.focus();
      }
    }

    function closeModal() {
      modal.classList.remove('open');
      if (btnHowToUse) {
        btnHowToUse.setAttribute('aria-expanded', 'false');
        btnHowToUse.focus();
      }
      document.body.style.overflow = '';
    }

    if (btnHowToUse) {
      btnHowToUse.addEventListener('click', (e) => {
        e.preventDefault();
        openModal();
      });
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', closeModal);
    }

    if (gotItBtn) {
      gotItBtn.addEventListener('click', closeModal);
    }

    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeModal();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.classList.contains('open')) {
        closeModal();
      }
    });

    // Auto-open if query param ?guide=1 or hash #guide is present
    try {
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.get('guide') === '1' || window.location.hash === '#guide') {
        openModal();
      }
    } catch (_) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initGuideModal);
  } else {
    initGuideModal();
  }
})();
