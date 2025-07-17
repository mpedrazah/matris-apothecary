const API_BASE = "https://www.bascombreadco.com"; // ✅ Fix missing https://

// ✅ Fetch Orders from Backend
async function fetchOrders() {
  try {
    console.log("📡 Fetching orders from backend...");
    const response = await fetch(`${API_BASE}/get-orders`);
    if (!response.ok) throw new Error(`Failed to fetch orders: ${response.statusText}`);

    const orders = await response.json();
    console.log("✅ Orders received:", orders);
    
    if (orders.length === 0) {
      document.getElementById("orders-list").innerHTML = "<p>No orders found.</p>";
      return;
    }

    displayOrders(orders);
  } catch (error) {
    console.error("❌ Error fetching orders:", error);
    document.getElementById("orders-list").innerHTML = "<p>Error loading orders. Please try again.</p>";
  }
}

// ✅ Display Orders in HTML
function displayOrders(orders) {
  const ordersContainer = document.getElementById("orders-list");
  ordersContainer.innerHTML = ""; // Clear existing content

  orders.forEach(order => {
    const orderElement = document.createElement("div");
    orderElement.classList.add("order-card");
    orderElement.innerHTML = `
      <p><strong>Email:</strong> ${order.email}</p>
      <p><strong>Pickup Date:</strong> ${order.pickup_day || "N/A"}</p>
      <p><strong>Items:</strong> ${order.items}</p>
      <p><strong>Total:</strong> ${order.total_price}</p>
      <p><strong>Payment Method:</strong> ${order.payment_method}</p> 
      <hr>
    `;
    ordersContainer.appendChild(orderElement);
  });
}


// ✅ Ensure the DOM is fully loaded before attaching event listeners
document.addEventListener("DOMContentLoaded", () => {
  console.log("✅ DOM fully loaded. Initializing admin page...");

  // ✅ Check if the button exists before adding event listener
  const exportOrdersBtn = document.getElementById("export-orders-btn");
  if (exportOrdersBtn) {
    exportOrdersBtn.addEventListener("click", exportOrders);
  } else {
    console.warn("⚠️ Warning: #export-orders-btn not found in DOM.");
  }

  fetchOrders(); // Ensure orders are fetched when the page loads
});

// ✅ Export Orders as CSV
function exportOrders() {
  console.log("📤 Exporting orders...");
  window.location.href = `${API_BASE}/export-orders`;
}
