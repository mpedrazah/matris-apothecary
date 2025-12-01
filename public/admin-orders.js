// admin-orders.js
const API_BASE = "https://www.matrisapothecary.com";

/* ===================== helpers ===================== */
const escapeHTML = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

const isFiniteNum = (n) => Number.isFinite(Number(n));

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

const calcItemsSubtotal = (cartArr) =>
  cartArr.reduce((sum, i) => {
    const price =
      Number(
        // prefer discountedPrice if present; else use price
        (i && (i.discountedPrice ?? i.price)) || 0
      ) || 0;
    const qty = Number(i?.quantity || 1);
    return sum + price * qty;
  }, 0);

/* ===== Admin-token (prompt once, cache in sessionStorage) ===== */
let ADMIN_TOKEN = sessionStorage.getItem("adminToken") || "";
async function ensureAdminToken() {
  if (ADMIN_TOKEN) return ADMIN_TOKEN;
  const t = prompt("Enter admin token to resend emails:");
  if (!t) throw new Error("Admin token required");
  ADMIN_TOKEN = t.trim();
  sessionStorage.setItem("adminToken", ADMIN_TOKEN);
  return ADMIN_TOKEN;
}

/* ===================== fetch + render ===================== */
async function fetchOrders() {
  try {
    const res = await fetch(`${API_BASE}/get-orders`, { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const orders = await res.json();

    if (!Array.isArray(orders) || orders.length === 0) {
      document.getElementById("orders-list").innerHTML = "<p>No orders found.</p>";
      return;
    }

    displayOrders(orders);
    attachResendHandlers();
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
      const id = o.id ?? "—";
      const name = escapeHTML(o.name || "");
      const email = escapeHTML(o.email || "");
      const emailLink = o.email ? `mailto:${encodeURIComponent(o.email)}` : "#";
      const created = o.created_at ? fmtDate(o.created_at) : "—";
      const pay = escapeHTML(o.payment_method || "—");
      const optIn = o.email_opt_in ? "Yes" : "No";

      const delivery = (o.delivery_method || "—").toString();
      const shipMethodRaw = (o.shipping_method || "").toString();
      const shipMethod = shipMethodRaw.replace(/_/g, " ").trim() || "—";
      const shippingFee = fmtMoney(o.shipping_fee);

      const cartArr = parseCart(o.cart);
      const itemsHTML = cartArr.length
        ? `<ul class="items-list">` +
          cartArr
            .map((i) => {
              const n = escapeHTML(i?.name ?? "Item");
              const qty = i?.quantity ?? 1;
              const maybePrice = i?.discountedPrice ?? i?.price;
              const price = isFiniteNum(maybePrice) ? ` — ${fmtMoney(maybePrice)}` : "";
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

      // total: prefer DB 'total'; if missing/null, compute fallback
      let totalDisplay = "—";
      if (isFiniteNum(o.total)) {
        totalDisplay = fmtMoney(o.total);
      } else {
        const subtotal = calcItemsSubtotal(cartArr);
        const computed = subtotal + (Number(o.shipping_fee) || 0);
        totalDisplay = isFiniteNum(computed) && computed > 0 ? fmtMoney(computed) : "—";
      }

      // Add resend control + status line
      return `
        <article class="order-card" data-order-id="${id}">
          <header class="order-header">
            <div><strong>Order #${id}</strong></div>
            <div class="order-date">${created}</div>
          </header>

          <div class="order-body">
            <div class="row"><span class="label">Name:</span> ${name || "—"}</div>
            <div class="row"><span class="label">Email:</span> <a href="${emailLink}">${email || "—"}</a></div>
            <div class="row"><span class="label">Payment Method:</span> ${pay}</div>
            <div class="row"><span class="label">Email Opt-In:</span> ${optIn}</div>

            <div class="row"><span class="label">Delivery:</span> ${escapeHTML(delivery)}</div>
            <div class="row"><span class="label">Shipping Method:</span> ${escapeHTML(shipMethod)}</div>
            <div class="row"><span class="label">Shipping Fee:</span> ${shippingFee}</div>

            <div class="row"><span class="label">Items:</span> ${itemsHTML}</div>
            <div class="row total"><span class="label">Total:</span> ${totalDisplay}</div>

            <div class="row" style="margin-top:10px; display:flex; gap:8px; align-items:center;">
              <button class="resend-email-btn" data-order-id="${id}">Resend Email</button>
              <span class="resend-status" style="font-size:.9rem; color:#666;"></span>
            </div>
          </div>
        </article>
      `;
    })
    .join("");
}

/* ===================== resend controls ===================== */
function attachResendHandlers() {
  const buttons = document.querySelectorAll(".resend-email-btn");
  buttons.forEach((btn) => {
    btn.addEventListener("click", onResendClick);
  });
}

async function onResendClick(e) {
  const btn = e.currentTarget;
  const orderId = btn.dataset.orderId;
  const card = btn.closest(".order-card");
  const status = card?.querySelector(".resend-status");
  try {
    const token = await ensureAdminToken();
    btn.disabled = true;
    btn.textContent = "Sending…";
    if (status) status.textContent = "";

    const resp = await fetch(`${API_BASE}/admin/resend-confirmation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-token": token
      },
      body: JSON.stringify({ order_id: Number(orderId) })
    });

    if (!resp.ok) {
      const msg = await resp.text();
      throw new Error(msg || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    if (!data?.success) {
      throw new Error(data?.error || "Unknown error");
    }

    if (status) {
      status.style.color = "#2f7a3e";
      status.textContent = "✅ Email resent successfully.";
    }
  } catch (err) {
    console.error("Resend failed:", err);
    if (status) {
      status.style.color = "#b00020";
      status.textContent = `❌ Failed to resend: ${err.message || err}`;
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "Resend Email";
  }
}

/* ===================== export ===================== */
function exportOrders() {
  window.location.href = `${API_BASE}/export-orders`;
}

/* ===================== init ===================== */
document.addEventListener("DOMContentLoaded", () => {
  const exportBtn = document.getElementById("export-orders-btn");
  if (exportBtn) exportBtn.addEventListener("click", exportOrders);
  fetchOrders();
});
