// admin-orders.js
const API_BASE = "https://www.matrisapothecary.com"; // keep https scheme

// ---------- helpers ----------
const escapeHTML = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

const fmtMoney = (n) => {
  const x = Number(n);
  return Number.isFinite(x)
    ? x.toLocaleString("en-US", { style: "currency", currency: "USD" })
    : "—";
};

const fmtDate = (d) => {
  try {
    return new Date(d).toLocaleString([], {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
};

const parseCart = (cart) => {
  try {
    const v = typeof cart === "string" ? JSON.parse(cart) : cart;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

// ---------- fetch + render ----------
async function fetchOrders() {
  try {
    console.log("📡 Fetching orders from backend...");
    const res = await fetch(`${API_BASE}/get-orders`, { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const orders = await res.json();
    console.log("✅ Orders received:", orders);

    if (!Array.isArray(orders) || orders.length === 0) {
      document.getElementById("orders-list").innerHTML = "<p>No orders found.</p>";
      return;
    }

    displayOrders(orders);
  } catch (err) {
    console.error("❌ Error fetching orders:", err);
    document.getElementById("orders-list").innerHTML =
      "<p>Error loading orders. Please try again.</p>";
  }
}

function displayOrders(orders) {
  const container = document.getElementById("orders-list");
  if (!container) return;

  container.innerHTML = orders
    .map((o) => {
      const name = escapeHTML(o.name || "");
      const email = escapeHTML(o.email || "");
      const emailLink = o.email ? `mailto:${encodeURIComponent(o.email)}` : "#";
      const created = o.created_at ? fmtDate(o.created_at) : "—";
      const total = fmtMoney(o.total);
      const pay = escapeHTML(o.payment_method || "—");
      const optIn = o.email_opt_in ? "Yes" : "No";

      const cartArr = parseCart(o.cart);
      const itemsHTML = cartArr.length
        ? `<ul class="items-list">` +
          cartArr
            .map((i) => {
              const n = escapeHTML(i?.name ?? "Item");
              const qty = i?.quantity ?? 1;
              const price = Number.isFinite(Number(i?.price))
                ? ` — ${fmtMoney(i.price)}`
                : "";
              const details = [i?.size, i?.fragrance, i?.variant, i?.option]
                .filter(Boolean)
                .map(escapeHTML)
                .join(", ");
              const detailsHTML = details ? ` <small>(${details})</small>` : "";
              return `<li>• ${n}${detailsHTML} ×${qty}${price}</li>`;
            })
            .join("") +
          `</ul>`
        : "<em>—</em>";

      return `
        <article class="order-card">
          <header class="order-header">
            <div><strong>Order #${o.id ?? "—"}</strong></div>
            <div class="order-date">${created}</div>
          </header>

          <div class="order-body">
            <div class="row"><span class="label">Name:</span> ${name || "—"}</div>
            <div class="row"><span class="label">Email:</span> <a href="${emailLink}">${email || "—"}</a></div>
            <div class="row"><span class="label">Payment Method:</span> ${pay}</div>
            <div class="row"><span class="label">Email Opt-In:</span> ${optIn}</div>
            <div class="row"><span class="label">Items:</span> ${itemsHTML}</div>
            <div class="row total"><span class="label">Total:</span> ${total}</div>
          </div>
        </article>
      `;
    })
    .join("");
}

// ---------- export ----------
function exportOrders() {
  console.log("📤 Exporting orders...");
  window.location.href = `${API_BASE}/export-orders`;
}

// ---------- init ----------
document.addEventListener("DOMContentLoaded", () => {
  console.log("✅ DOM ready. Loading orders…");
  const exportBtn = document.getElementById("export-orders-btn");
  if (exportBtn) {
    exportBtn.addEventListener("click", exportOrders);
  }
  fetchOrders();
});
