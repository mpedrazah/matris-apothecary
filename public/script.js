document.addEventListener("DOMContentLoaded", () => {
  // ---- Optional: Stripe checkout button (guarded) ----
  const checkoutBtn = document.getElementById("checkout-button");
  if (checkoutBtn) {
    checkoutBtn.addEventListener("click", function () {
      console.log("Checkout button clicked!");
      fetch("http://localhost:3000/create-checkout-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
        .then((r) => r.json())
        .then((session) => {
          console.log("Session URL:", session.url);
          if (session?.url) window.location.href = session.url;
        })
        .catch((err) => console.error("Error:", err));
    });
  }

  // ---- Mobile nav toggle (single, safe implementation) ----
  const toggle = document.getElementById("menu-toggle");
  const menu = document.getElementById("mobile-menu");
  if (!toggle || !menu) {
    console.warn("Mobile menu elements not found on this page.");
    return;
  }

  // Ensure correct initial state based on viewport (no FOUC)
  const enforceState = () => {
    if (window.innerWidth >= 641) {
      menu.classList.remove("mobile-hidden");
      toggle.setAttribute("aria-expanded", "true");
    } else {
      menu.classList.add("mobile-hidden");
      toggle.setAttribute("aria-expanded", "false");
    }
  };
  enforceState();

  // Toggle on click
  toggle.addEventListener("click", () => {
    menu.classList.toggle("mobile-hidden");
    const expanded = !menu.classList.contains("mobile-hidden");
    toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  });

  // Close after clicking a link (mobile UX)
  menu.querySelectorAll("a").forEach((a) =>
    a.addEventListener("click", () => menu.classList.add("mobile-hidden"))
  );

  // Re-enforce on resize
  window.addEventListener("resize", enforceState);
});

(() => {
  const lb = document.getElementById('lightbox');
  const lbImg = lb.querySelector('.lightbox__img');
  const lbClose = lb.querySelector('.lightbox__close');

  function openLightbox(src, alt='') {
    lbImg.src = src;
    lbImg.alt = alt;
    lb.classList.add('open');
    lb.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden'; // lock scroll
  }
  function closeLightbox() {
    lb.classList.remove('open');
    lb.setAttribute('aria-hidden', 'true');
    lbImg.src = '';
    document.body.style.overflow = '';
  }

  // Open when clicking any product image
  document.addEventListener('click', (e) => {
    const img = e.target.closest('.product-card img');
    if (!img) return;
    // Use data-full for higher-res if provided; fall back to current src
    const src = img.getAttribute('data-full') || img.src;
    openLightbox(src, img.alt || '');
  });

  // Close interactions
  lbClose.addEventListener('click', closeLightbox);
  lb.addEventListener('click', (e) => { if (e.target === lb) closeLightbox(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });
})();

