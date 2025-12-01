// ✅ Modify `payWithVenmo` to Use Firestore
const API_BASE = "https://matris-apothecary.up.railway.app"; // Update with Render URL

let cart = JSON.parse(localStorage.getItem("cart")) || [];


let discountAmount = 0; // Stores the applied discount
const discountCodes = {
  "ICON10": 0.10,  // 10% off
  "TEST100": 1 // \0% off for test purposes
};


// --- Shipping + totals helpers ---
const SHIPPING_RATES = { pickup: 0, shipping: 7.00 }; // change if needed<

function getDeliveryMethod() {
  return document.getElementById("delivery-method")?.value || "pickup";
}

// Recompute and paint fees/total on the checkout page
function recomputeTotals() {
  const feeEl = document.getElementById("convenience-fee");
  const shipEl = document.getElementById("shipping-fee");
  const totalEl = document.getElementById("cart-total");
  const payFeeEl = document.getElementById("payment-fee");
  if (!feeEl || !shipEl || !totalEl) return;

  // always read the latest cart from storage in case it changed elsewhere
  const currentCart = JSON.parse(localStorage.getItem("cart")) || [];

  const subtotal = currentCart.reduce((sum, item) => {
    const base = Number(item.price) || 0;
    const discounted = discountAmount > 0 ? base * (1 - discountAmount) : base;
    return sum + discounted * (item.quantity || 1);
  }, 0);

  const deliveryMethod = getDeliveryMethod();
  const shippingFee = deliveryMethod === "shipping" ? SHIPPING_RATES.shipping : 0;

  let convenienceFee = parseFloat((subtotal * 0.03).toFixed(2));
  let venmoDiscount = 0;
  if (paymentMethod === "Venmo") {
    venmoDiscount = convenienceFee;
    convenienceFee = 0;
  }

  const total = subtotal + shippingFee + convenienceFee - venmoDiscount;

  shipEl.textContent = `Shipping Fee: $${shippingFee.toFixed(2)}`;
  feeEl.textContent = `Online Convenience Fee: $${convenienceFee.toFixed(2)}`;
  if (payFeeEl) {
    payFeeEl.textContent = paymentMethod === "Venmo"
      ? `Venmo Discount: -$${venmoDiscount.toFixed(2)}`
      : "";
  }
  totalEl.textContent = `Total: $${total.toFixed(2)}`;
}



// ✅ Fetch Pickup Slots from Google Sheets

// ✅ Save Order to Backend CSV
async function saveOrderToCSV(orderData) {
  console.log("📤 Sending order to backend CSV:", orderData);

  try {
    const response = await fetch(`${API_BASE}/save-order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(orderData),
    });

    const responseData = await response.json();
    if (!responseData.success) throw new Error(responseData.error);
    console.log("✅ Order saved successfully!");
  } catch (error) {
    console.error("❌ Order submission failed:", error);
    alert("Error saving order. Please try again.");
  }
}


// ✅ Toast Notification Function
function showToast(message) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerText = message;
  document.body.appendChild(toast);

  // Trigger fade-in
  setTimeout(() => {
      toast.classList.add("visible");
  }, 100);

  // Fade out and remove after 3 seconds
  setTimeout(() => {
      toast.classList.remove("visible");
      setTimeout(() => {
          document.body.removeChild(toast);
      }, 500);
  }, 3000);
}


// Function to add item to cart
function addToCart(name, price, image) {
  // use the global `cart` and keep it in sync with localStorage
  const existingItem = cart.find(item => item.name === name);
  if (existingItem) {
    existingItem.quantity += 1;
  } else {
    cart.push({ name, price, quantity: 1, image });
  }

  localStorage.setItem("cart", JSON.stringify(cart));
  updateCartCount();
  recomputeTotals();
  showToast(`${name} added to cart.`);
}



// ✅ Ensure it's globally accessible
window.showToast = showToast;


function applyDiscount() {
  const discountInput = document.getElementById("discount-code").value.trim().toUpperCase();
  const discountMessage = document.getElementById("discount-message");

  if (discountCodes[discountInput]) {
    discountAmount = discountCodes[discountInput]; // Store discount percentage
    discountMessage.innerText = `✅ Discount applied: ${discountAmount * 100}% off!`;
    discountMessage.style.color = "green";
  } else {
    discountAmount = 0;
    discountMessage.innerText = "❌ Invalid discount code.";
    discountMessage.style.color = "red";
  }

  renderCartItems(); // Update total price after discount
}

let venmoPaymentAttempted = false; // Prevent duplicate submissions

async function payWithVenmo() {
  if (venmoPaymentAttempted) return;
  venmoPaymentAttempted = true;

  if (cart.length === 0) {
    alert("Your cart is empty!");
    venmoPaymentAttempted = false;
    return;
  }

  const email = document.getElementById("email")?.value.trim();
  const deliveryMethod = document.getElementById("delivery-method")?.value;
  const emailOptIn = document.getElementById("email-opt-in")?.checked || false;
  const discountCode = document.getElementById("discount-code")?.value.trim().toUpperCase();

  if (!email) {
    alert("Please enter your email.");
    venmoPaymentAttempted = false;
    return;
  }

  const shippingInfo = deliveryMethod === "shipping" ? {
    name: document.getElementById("shipping-name").value,
    address: document.getElementById("shipping-address-line").value,
    city: document.getElementById("shipping-city").value,
    state: document.getElementById("shipping-state").value,
    zip: document.getElementById("shipping-zip").value
  } : null;

  if (deliveryMethod === "shipping" && Object.values(shippingInfo).some(v => !v)) {
    alert("Please fill out all shipping fields.");
    venmoPaymentAttempted = false;
    return;
  }

  // Apply discount to cart
  let subtotal = 0;
  const updatedCart = cart.map(item => {
    let price = item.price;
    if (discountCodes[discountCode]) {
      price -= price * discountCodes[discountCode];
    }
    subtotal += price * item.quantity;
    return { name: item.name, price, quantity: item.quantity };
  });

  const shippingFee = deliveryMethod === "shipping" ? 7.00 : 0;
  let venmoAmount = subtotal + shippingFee;
  venmoAmount = Math.max(venmoAmount, 0).toFixed(2);

  const orderSummary = updatedCart.map(item => `${item.name} (x${item.quantity})`).join(", ");
  const noteLines = [
    "Matris Apothecary Order",
    deliveryMethod === "shipping" ? "Shipping Order" : "Local Pickup (we’ll email to coordinate)",
    orderSummary
  ];
  const note = encodeURIComponent(noteLines.join("\n"));

  const orderData = {
    name: email.split("@")[0],
    email,
    items: orderSummary,
    total_price: venmoAmount,
    payment_method: "Venmo",
    email_opt_in: emailOptIn,
    cart: updatedCart,
    delivery_method: deliveryMethod,
    shipping_info: shippingInfo
  };

  try {
    const response = await fetch(`${API_BASE}/save-order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(orderData),
    });

    const result = await response.json();
    if (!result.success) throw new Error("Failed to save order.");

    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    const venmoLink = isMobile
      ? `venmo://paycharge?txn=pay&recipients=HarrisonHousehold&amount=${venmoAmount}&note=${note}`
      : `https://venmo.com/HarrisonHousehold?txn=pay&amount=${venmoAmount}&note=${note}`;

    if (isMobile) {
      window.location.href = venmoLink;
      setTimeout(() => { window.location.href = "success.html"; }, 3000);
    } else {
      const venmoWindow = window.open(venmoLink, "_blank");
      if (!venmoWindow) alert("Venmo did not open. Please complete payment manually.");
      setTimeout(() => { window.location.href = "success.html"; }, 5000);
    }

    localStorage.removeItem("cart");
    updateCartCount();
  } catch (error) {
    console.error("❌ Venmo order submission failed:", error);
    alert("There was an issue processing your Venmo payment.");
  }

  setTimeout(() => { venmoPaymentAttempted = false; }, 30000);
}


// ✅ Make function globally accessible
window.payWithVenmo = payWithVenmo;
async function checkout() {
  const email = document.getElementById("email").value;
  const emailOptIn = document.getElementById("email-opt-in")?.checked || false;
  const deliveryMethod = document.getElementById("delivery-method").value;
  const discountCode = (document.getElementById("discount-code")?.value || "")
    .trim().toUpperCase();

  if (!email) { alert("Please enter your email."); return; }

  const cart = JSON.parse(localStorage.getItem("cart") || "[]");
  if (cart.length === 0) { alert("Your cart is empty."); return; }

  const shippingInfo = deliveryMethod === "shipping" ? {
    name: document.getElementById("shipping-name").value,
    address: document.getElementById("shipping-address-line").value,
    city: document.getElementById("shipping-city").value,
    state: document.getElementById("shipping-state").value,
    zip: document.getElementById("shipping-zip").value
  } : null;

  if (deliveryMethod === "shipping" && Object.values(shippingInfo).some(v => !v)) {
    alert("Please fill out all shipping fields."); return;
  }

  const paymentMethod = window.event?.target?.id === "venmo-button" ? "Venmo" : "Card";
  const shippingMethod = deliveryMethod === "shipping" ? "flat" : "pickup";

  const response = await fetch(`${API_BASE}/create-checkout-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cart,
      email,
      payment_method: paymentMethod,
      emailOptIn,
      delivery_method: deliveryMethod,
      shipping_method: shippingMethod,
      shipping_info: shippingInfo,
      discount_code: discountCode           // ✅ send it
    })
  });

  const data = await response.json();
  if (data.url) window.location.href = data.url;
  else { alert("Checkout error."); console.error(data.error); }
}



// ✅ Make function globally accessible
window.checkout = checkout;


let paymentMethod = "Stripe"; // Default to Stripe

// Function to set payment method
function setPaymentMethod(method) {
    paymentMethod = method;
    renderCartItems();
    recomputeTotals();
}

// ✅ Renders Cart Items with Image Support and Discount Application
function renderCartItems() {
  const cartContainer = document.getElementById("cart-items");
  const totalContainer = document.getElementById("cart-total");
  if (!cartContainer || !totalContainer) return;

  cartContainer.innerHTML = "";
  cart.forEach((item, index) => {
    const imageUrl = item.image || "images/freshmillloaf.jpg";
    const originalPrice = item.price;
    const discountedPrice = discountAmount > 0 ? originalPrice * (1 - discountAmount) : originalPrice;

    cartContainer.innerHTML += `
      <div class="cart-item">
        <div class="item-info">
          <img src="${imageUrl}" alt="${item.name}">
          <div>
            <h4>${item.name}</h4>
            <p>
              Price:
              ${
                discountAmount > 0
                  ? `<span style="text-decoration: line-through; color: gray;">$${originalPrice.toFixed(2)}</span>
                     <span style="color: green;"> $${discountedPrice.toFixed(2)}</span>`
                  : `$${originalPrice.toFixed(2)}`
              }
            </p>
          </div>
        </div>
        <input type="number" value="${item.quantity}" min="1" onchange="updateQuantity(${index}, this.value)" />
        <button onclick="removeFromCart(${index})">Remove</button>
      </div>
    `;
  });

  recomputeTotals(); // ✅ keep totals in sync
}




// ✅ Ensures Global Accessibility
window.renderCartItems = renderCartItems;
window.applyDiscount = applyDiscount;


// Checkout function
// Ensure the checkbox state is remembered
document.addEventListener("DOMContentLoaded", function () {
  const emailOptIn = document.getElementById("email-opt-in");
  const emailInput = document.getElementById("email");

  // Load stored preference when the email field changes
  emailInput.addEventListener("input", () => {
      const savedPreference = localStorage.getItem(`email-opt-in-${emailInput.value}`);
      if (savedPreference !== null) {
          emailOptIn.checked = JSON.parse(savedPreference);
      }
  });

  // Save preference when checkbox is clicked
  emailOptIn.addEventListener("change", () => {
      if (emailInput.value.trim()) {
          localStorage.setItem(`email-opt-in-${emailInput.value}`, emailOptIn.checked);
      }
  });
});



// ✅ Ensure the cart count updates after DOM is fully loaded
document.addEventListener("DOMContentLoaded", function () {
  setTimeout(updateCartCount, 100); // Small delay to ensure elements are available
});


function updateQuantity(index, newQuantity) {
  cart[index].quantity = parseInt(newQuantity, 10);
  localStorage.setItem("cart", JSON.stringify(cart));
  renderCartItems();
  updateCartCount();
}

function removeFromCart(index) {
  cart.splice(index, 1);
  localStorage.setItem("cart", JSON.stringify(cart));
  renderCartItems();
  updateCartCount();
}





// Load cart on page load
document.addEventListener("DOMContentLoaded", () => {
  renderCartItems();
  updateCartCount();
  recomputeTotals(); // shipping
});


// Ensure functions are accessible globally
window.renderCartItems = renderCartItems;
window.updateQuantity = updateQuantity;
window.removeFromCart = removeFromCart;
window.updateCartCount = updateCartCount;
window.addToCart = addToCart;



document.addEventListener("DOMContentLoaded", function () {
  console.log("✅ DOM fully loaded. Running updateCartCount()...");

  // Ensure cart count is updated when the page loads
  updateCartCount();

  // Debugging logs
  console.log("🛒 Cart on load:", localStorage.getItem("cart"));
  console.log("🔄 Cart count updated to:", document.getElementById("cart-count")?.textContent);

  // Ensure cart buttons exist before adding event listeners
  const stripeButton = document.getElementById("stripe-button");
  const venmoButton = document.getElementById("venmo-button");

  if (stripeButton) {
      stripeButton.addEventListener("click", function () {
          setPaymentMethod("Stripe");
          checkout();
      });
  } else {
      console.warn("⚠️ `#stripe-button` not found on this page.");
  }

  if (venmoButton) {
    venmoButton.removeEventListener("click", payWithVenmo); // ✅ Ensure no duplicate listeners
    venmoButton.addEventListener("click", function () {
        setPaymentMethod("Venmo");
        payWithVenmo();  // ✅ Correct function - Ensures only Venmo runs
    });
} else {
    console.warn("⚠️ `#venmo-button` not found on this page.");
}

});

// Ensure updateCartCount() works globally
function updateCartCount() {
  console.log("🔄 Running updateCartCount()...");

  let cart = JSON.parse(localStorage.getItem("cart")) || [];
  let totalCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  
  const cartCountElement = document.getElementById("cart-count");
  if (cartCountElement) {
      cartCountElement.textContent = totalCount;
      console.log("✅ Cart count updated:", totalCount);
  } else {
      console.warn("❌ `#cart-count` element not found.");
  }
}



function addMoisturizingCreamToCart() {
  const sizeSelect = document.getElementById("moisturizing-size");
  const fragranceSelect = document.getElementById("moisturizing-fragrance");

  const size = sizeSelect.options[sizeSelect.selectedIndex].value;
  const price = parseFloat(sizeSelect.options[sizeSelect.selectedIndex].dataset.price);
  const fragrance = fragranceSelect.value;

  const name = `Tallow Moisturizing Cream (${size} oz - ${fragrance})`;

  // Choose different images based on size
  const image = size === "2"
    ? "images/moisturizingcream4oz.jpg"
    : "images/moisturizingcream4oz.jpg";

  addToCart(name, price, image);
}




function addSunscreenToCart() {
  const sizeSelect = document.getElementById("sunscreen-size");
  const fragranceSelect = document.getElementById("sunscreen-fragrance");

  const size = sizeSelect.options[sizeSelect.selectedIndex].value;
  const price = parseFloat(sizeSelect.options[sizeSelect.selectedIndex].dataset.price);
  const fragrance = fragranceSelect.value;

  const name = `Tallow Sunscreen (${size} oz - ${fragrance})`;
  
  const image = size === "2"
  ? "images/sunscreen2oz.jpg"
  : "images/sunscreen4oz.jpg";


  addToCart(name, price, image);
}

function addHappyBalmToCart() {
  const sizeSelect = document.getElementById("happy-size");
  const size = sizeSelect.options[sizeSelect.selectedIndex].value;
  const price = parseFloat(sizeSelect.options[sizeSelect.selectedIndex].dataset.price);
  const name = `Happy Lips & Skin Balm (${size} oz)`;
  const image = "images/tallow-balm.webp";

  addToCart(name, price, image);
}

function addMagnesiumCreamToCart() {
  const sel = document.getElementById('mag-cream-size');
  const size = sel.value;
  const price = parseFloat(sel.options[sel.selectedIndex].dataset.price);
  addToCart(`Tallow Magnesium Cream (${size} oz)`, price, 'images/magnesiumcream.jpg');
}


function addLotionBarToCart() {
  const fragranceSelect = document.getElementById("lotion-fragrance");
  const fragrance = fragranceSelect.value;

  const name = `Tallow Moisturizing Cream (2 oz - ${fragrance})`;

  // Choose different images based on size
  const image = "images/lotionbar1.jpg"

  addToCart(name, price, image);
}