document.getElementById("checkout-button").addEventListener("click", function() {
    console.log("Checkout button clicked!"); // Debugging log

    fetch("http://localhost:3000/create-checkout-session", { 
        method: "POST",
        headers: { "Content-Type": "application/json" }
    })
    .then(response => response.json())
    .then(session => {
        console.log("Session URL:", session.url);
        window.location.href = session.url; // Redirect to Stripe Checkout
    })
    .catch(error => console.error("Error:", error));
});


document.addEventListener("DOMContentLoaded", function () {
  const toggle = document.getElementById("menu-toggle");
  const menu = document.getElementById("mobile-menu");

  toggle.addEventListener("click", () => {
    menu.classList.toggle("mobile-hidden");
  });
});

document.addEventListener("DOMContentLoaded", () => {
  const toggle = document.getElementById("menu-toggle");
  const menu = document.getElementById("mobile-menu");
  if (!toggle || !menu) return;

  // Toggle menu on click
  toggle.addEventListener("click", () => {
    menu.classList.toggle("mobile-hidden");
    toggle.setAttribute(
      "aria-expanded",
      menu.classList.contains("mobile-hidden") ? "false" : "true"
    );
  });

  // Close menu when a link is clicked (mobile UX)
  menu.querySelectorAll("a").forEach(a =>
    a.addEventListener("click", () => menu.classList.add("mobile-hidden"))
  );

  // Keep menu visible on desktop, hidden on mobile
  const enforceState = () => {
    if (window.innerWidth >= 641) {
      menu.classList.remove("mobile-hidden");
    } else {
      menu.classList.add("mobile-hidden");
    }
  };
  enforceState();
  window.addEventListener("resize", enforceState);
});
