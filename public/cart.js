// ✅ Modify `payWithVenmo` to Use Firestore
const API_BASE = "https://bascombreadco.up.railway.app"; // Update with Render URL

let cart = JSON.parse(localStorage.getItem("cart")) || [];
let pickupSlots = {};
let remainingSlotsForSelectedDay = null;


let discountAmount = 0; // Stores the applied discount
const discountCodes = {
  "ICON10": 0.10,  // 10% off
  "TEST100": 1 // 50% off for test purposes
};



// ✅ Fetch Pickup Slots from Google Sheets
async function fetchPickupSlotsFromGoogleSheets() {
  const sheetURL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRLeiHAcr4m4Q_4yFuZXtxlj_kqc6V8ZKaPOgsZS0HHCZReMr-vTX2KEXOB8qqgduHPZLsbIF281YoA/pub?output=csv";

  try {
    const response = await fetch(sheetURL);
    if (!response.ok) throw new Error("Failed to fetch Google Sheets data");

    const csvText = await response.text();
    parsePickupSlotsData(csvText);
  } catch (error) {
    console.error("❌ Error fetching pickup slots:", error);
  }
}

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


let pickupSlotStatus = {}; // global cache

async function fetchPickupSlotStatus() {
  function normalizeDateString(dateStr) {
    // Trim, collapse multiple spaces, and remove accidental trailing commas or whitespace
    return dateStr.trim().replace(/\s+/g, " ").replace(/,\s*$/, "");
  }

  try {
    const response = await fetch(`${API_BASE}/pickup-slot-status`);
    const data = await response.json();

    pickupSlotStatus = data.reduce((acc, row) => {
      const cleanDate = normalizeDateString(row.date);
      acc[cleanDate] = {
        pickupLimit: row.available,
        itemsAlreadyOrdered: row.ordered,
        remaining: row.remaining
      };
      return acc;
    }, {});

    console.log("✅ Loaded pickup slot status:", pickupSlotStatus);

    // ✅ Wait to populate dropdown
    populatePickupDayDropdown();

    // ✅ Set default pickup_day manually (important!)
    const pickupDayElement = document.getElementById("pickup-day");
    if (pickupDayElement && pickupDayElement.value) {
      const normalized = normalizeDateString(pickupDayElement.value);
      remainingSlotsForSelectedDay = pickupSlotStatus[normalized]?.remaining || 0;
    }

  } catch (err) {
    console.error("❌ Failed to load pickup slot status:", err);
  }
}

// Convert CSV into JavaScript Object
function parsePickupSlotsData(csvText) {
  const rows = csvText.trim().split("\n").slice(1); // Skip header row
  pickupSlots = {}; // Reset slots

  rows.forEach(row => {
    const [date, available, booked] = row.split(","); // Extract columns
    if (date && available) {
      pickupSlots[date] = {
        available: parseInt(available),
        booked: parseInt(booked) || 0
      };
    }
  });

  console.log("✅ Processed Pickup Slots:", pickupSlots);
}


function populatePickupDayDropdown() {
  const pickupDayElement = document.getElementById("pickup-day");
  if (!pickupDayElement) return;

  pickupDayElement.innerHTML = ""; // Clear old options

  let firstAvailable = null;

  Object.keys(pickupSlotStatus).forEach(date => {
    const { remaining } = pickupSlotStatus[date];
    const option = document.createElement("option");
    option.value = date;

    if (remaining <= 0) {
      option.disabled = true;
      option.textContent = `${date} - SOLD OUT`;
    } else {
      option.textContent = `${date} - ${remaining} slots left`;

      if (!firstAvailable) {
        firstAvailable = date;
      }
    }

    pickupDayElement.appendChild(option);
  });

  if (firstAvailable) {
    pickupDayElement.value = firstAvailable;
    remainingSlotsForSelectedDay = pickupSlotStatus[firstAvailable].remaining;

    console.log("✅ pickupDayElement.value = ", pickupDayElement.value);
    console.log("✅ remainingSlotsForSelectedDay = ", remainingSlotsForSelectedDay);
  } else {
    pickupDayElement.value = "";
    remainingSlotsForSelectedDay = 0;
  }

  console.log("📌 Initial pickup day selected:", pickupDayElement.value);
  console.log("📦 Remaining slots for selected:", remainingSlotsForSelectedDay);

  checkCartAvailability();

  pickupDayElement.addEventListener("change", () => {
    const selectedDay = pickupDayElement.value;
    remainingSlotsForSelectedDay = pickupSlotStatus[selectedDay]?.remaining || 0;
    console.log("🔁 Pickup day changed:", selectedDay);
    checkCartAvailability();
  });
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
  const cart = JSON.parse(localStorage.getItem("cart")) || [];

  const existingItem = cart.find(item => item.name === name);
  if (existingItem) {
    existingItem.quantity += 1;
  } else {
    cart.push({ name, price, quantity: 1, image });
  }

  localStorage.setItem("cart", JSON.stringify(cart));
  updateCartCount();
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

let venmoPaymentAttempted = false; // ✅ Prevent duplicate submissions

async function payWithVenmo() {
  if (venmoPaymentAttempted) return;
  venmoPaymentAttempted = true;

  if (cart.length === 0) {
    alert("Your cart is empty!");
    venmoPaymentAttempted = false;
    return;
  }

  const email = document.getElementById("email")?.value.trim();
  const pickup_day = document.getElementById("pickup-day")?.value;
  const emailOptIn = document.getElementById("email-opt-in")?.checked || false;
  const discountCode = document.getElementById("discount-code")?.value.trim().toUpperCase();

  if (!email || !pickup_day) {
    alert("Please enter your email and select a pickup date.");
    venmoPaymentAttempted = false;
    return;
  }

  // Apply discount
  let subtotal = 0;
  let updatedCart = cart.map(item => {
    let price = item.price;
    if (discountCodes[discountCode]) {
      price -= price * discountCodes[discountCode];
    }
    subtotal += price * item.quantity;
    return {
      name: item.name,
      price,
      quantity: item.quantity
    };
  });

  // Remove convenience fee for Venmo
  let venmoAmount = subtotal;
  venmoAmount = Math.max(venmoAmount, 0).toFixed(2);

  // Build order summary for backend and Venmo note
  const orderSummary = updatedCart.map(item => `${item.name} (x${item.quantity})`).join(", ");
  const note = encodeURIComponent(`Bascom Bread Order\n${pickup_day}\n${orderSummary}`);

  const orderData = {
    name: email.split("@")[0],
    email,
    pickup_day,
    items: orderSummary,
    total_price: venmoAmount,
    payment_method: "Venmo",
    email_opt_in: emailOptIn,
    cart: updatedCart
  };

  try {
    const response = await fetch(`${API_BASE}/save-order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(orderData),
    });

    const result = await response.json();
    if (!result.success) throw new Error("Failed to save order.");

    // Redirect to Venmo
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    const venmoLink = isMobile
      ? `venmo://paycharge?txn=pay&recipients=Margaret-Smillie&amount=${venmoAmount}&note=${note}`
      : `https://venmo.com/Margaret-Smillie?txn=pay&amount=${venmoAmount}&note=${note}`;

    if (isMobile) {
      window.location.href = venmoLink;
      setTimeout(() => {
        window.location.href = "success.html";
      }, 3000);
    } else {
      const venmoWindow = window.open(venmoLink, "_blank");
      if (!venmoWindow) {
        alert("Venmo did not open. Please complete payment manually.");
      }
      setTimeout(() => {
        window.location.href = "success.html";
      }, 5000);
    }

    localStorage.removeItem("cart");
    updateCartCount();

  } catch (error) {
    console.error("❌ Venmo order submission failed:", error);
    alert("There was an issue processing your Venmo payment.");
  }

  setTimeout(() => {
    venmoPaymentAttempted = false;
  }, 30000);
}





// ✅ Make function globally accessible
window.payWithVenmo = payWithVenmo;
async function checkout() {
  if (cart.length === 0) {
    alert("Your cart is empty!");
    return;
  }

  const email = document.getElementById("email")?.value.trim();
  const pickup_day = document.getElementById("pickup-day")?.value;
  const emailOptIn = document.getElementById("email-opt-in")?.checked || false;
  const discountCode = document.getElementById("discount-code")?.value.trim().toUpperCase() || null;

  if (!email || !pickup_day) {
    alert("Please enter your email and select a pickup date.");
    return;
  }

  // ✅ Apply discount if any
  if (discountCodes[discountCode]) {
    discountAmount = discountCodes[discountCode];
  } else {
    discountAmount = 0;
  }

  let subtotal = 0;
  const updatedCart = cart.map(item => {
    let price = item.price;
    if (discountAmount > 0) {
      price = price - price * discountAmount;
    }
    subtotal += price * item.quantity;
    return { name: item.name, price, quantity: item.quantity };
  });

  // ✅ Add 3% Stripe fee to subtotal
  const totalAmountWithFee = (subtotal * 1.03).toFixed(2);

  try {
    const response = await fetch(`${API_BASE}/create-checkout-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cart: updatedCart,
        email,
        pickup_day,
        emailOptIn,
        discountCode,
        totalAmount: totalAmountWithFee,
        payment_method: "Stripe",
      })
    });

    const stripeData = await response.json();
    if (stripeData.url) {
      window.location.href = stripeData.url;
    } else {
      alert("Error processing payment: " + stripeData.error);
    }
  } catch (error) {
    console.error("❌ Checkout failed:", error);
    alert("There was an error processing your payment.");
  }
}



// ✅ Make function globally accessible
window.checkout = checkout;



// ✅ Make function globally accessible
window.checkout = checkout;



let paymentMethod = "Stripe"; // Default to Stripe

// Function to set payment method
function setPaymentMethod(method) {
    paymentMethod = method;
    renderCartItems();
}

// ✅ Renders Cart Items with Image Support and Discount Application
function renderCartItems() {
  const cartContainer = document.getElementById("cart-items");
  const totalContainer = document.getElementById("cart-total");
  const feeContainer = document.getElementById("convenience-fee");
  const paymentFeeContainer = document.getElementById("payment-fee");
  const warningMessage = document.getElementById("warning-message");

  if (!cartContainer || !totalContainer) return;

  cartContainer.innerHTML = "";
  let subtotal = 0;

  cart.forEach((item, index) => {
    const imageUrl = item.image || "images/freshmillloaf.jpg";
    const originalPrice = item.price;
    const discountedPrice = discountAmount > 0 ? originalPrice * (1 - discountAmount) : originalPrice;

    subtotal += discountedPrice * item.quantity;

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

  let convenienceFee = subtotal * 0.03;
  convenienceFee = parseFloat(convenienceFee.toFixed(2));

  let venmoDiscount = 0;
  if (paymentMethod === "Venmo") {
    venmoDiscount = convenienceFee;
  }

  const total = subtotal + convenienceFee - venmoDiscount;

  feeContainer.innerText = `Online Convenience Fee: $${convenienceFee.toFixed(2)}`;
  paymentFeeContainer.innerText = paymentMethod === "Venmo" ? `Venmo Discount: -$${venmoDiscount.toFixed(2)}` : "";
  totalContainer.innerText = `Total: $${total.toFixed(2)}`;

  checkCartAvailability();
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


function updateCartCount() {
  console.log("🔄 Running updateCartCount()...");

  let cart = JSON.parse(localStorage.getItem("cart")) || [];

  // Show total number of items, including flour
  const totalCount = cart.reduce((sum, item) => sum + item.quantity, 0);

  const cartCountElement = document.getElementById("cart-count");
  if (cartCountElement) {
    cartCountElement.textContent = totalCount;
    console.log("✅ Cart count updated:", totalCount);
  } else {
    console.warn("❌ `#cart-count` element not found. Retrying in 5s...");
    setTimeout(updateCartCount, 5000);
  }
}




// ✅ Ensure the cart count updates after DOM is fully loaded
document.addEventListener("DOMContentLoaded", function () {
  setTimeout(updateCartCount, 100); // Small delay to ensure elements are available
});


// ✅ Update Quantity for a Cart Item
function updateQuantity(index, newQuantity) {
  cart[index].quantity = parseInt(newQuantity);
  localStorage.setItem("cart", JSON.stringify(cart));
  renderCartItems();
  updateCartCount();
  checkCartAvailability(); // ✅ Add this
}

// ✅ Remove Item from Cart
function removeFromCart(index) {
  cart.splice(index, 1);
  localStorage.setItem("cart", JSON.stringify(cart));
  renderCartItems();
  updateCartCount();
  checkCartAvailability();
}

async function loadRemainingSlots(pickupDay) {
  try {
    const response = await fetch(`${API_BASE}/remaining-slots?pickup_day=${encodeURIComponent(pickupDay)}`);
    const data = await response.json();
    remainingSlotsForSelectedDay = data.pickupLimit - data.itemsAlreadyOrdered;

    console.log(`📦 Remaining slots for ${pickupDay}:`, remainingSlotsForSelectedDay);

    checkCartAvailability(); // Run check now that we have the updated count
  } catch (error) {
    console.error("❌ Error loading remaining slots:", error);
  }
}

// Function to check cart availability against pickup slots
function checkCartAvailability() {
  const pickupDayElem = document.getElementById("pickup-day");
  const warningMessage = document.getElementById("warning-message");
  const stripeBtn = document.getElementById("stripe-button");
  const venmoBtn = document.getElementById("venmo-button");

  if (!pickupDayElem || !pickupDayElem.value || remainingSlotsForSelectedDay === null) return;

  const totalCartItems = cart.reduce((sum, item) => {
  return item.isFlour ? sum : sum + item.quantity;
}, 0);
  const remaining = remainingSlotsForSelectedDay;

  console.log(`🛒 Cart total: ${totalCartItems} vs Remaining slots: ${remaining}`);

  if (totalCartItems > remaining) {
    warningMessage.style.display = "block";
    warningMessage.innerText = `⚠️ Only ${remaining} slots left. You have ${totalCartItems} items.`;
    stripeBtn.disabled = true;
    stripeBtn.style.opacity = "0.5";
    stripeBtn.style.cursor = "not-allowed";

    venmoBtn.disabled = true;
    venmoBtn.style.opacity = "0.5";
    venmoBtn.style.cursor = "not-allowed";
  } else {
    warningMessage.style.display = "none";
    stripeBtn.disabled = false;
    stripeBtn.style.opacity = "1";
    stripeBtn.style.cursor = "pointer";

    venmoBtn.disabled = false;
    venmoBtn.style.opacity = "1";
    venmoBtn.style.cursor = "pointer";
  }
}



// Load cart on page load
document.addEventListener("DOMContentLoaded", () => {
  fetchPickupSlotStatus();  // 🔁 new function replaces fetchPickupSlotsFromGoogleSheets
  renderCartItems();
  updateCartCount();
});


// Ensure functions are accessible globally
window.renderCartItems = renderCartItems;
window.updateQuantity = updateQuantity;
window.removeFromCart = removeFromCart;
window.updateCartCount = updateCartCount;
window.checkCartAvailability = checkCartAvailability;
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

function updateBBCPrice() {
  const select = document.getElementById("bbc-variant");
  const selectedOption = select.options[select.selectedIndex];
  const price = parseFloat(selectedOption.dataset.price).toFixed(2);
  document.getElementById("bbc-price").textContent = `$${price}`;
}

function addBBCToCart() {
  const select = document.getElementById("bbc-option");
  const value = select.value;

  let name, price;

  if (value === "two") {
    name = "The BBC Classic";
    price = 4.00;
  } else {
    name = "The BBC Classic (dozen)";
    price = 18.00;
  }

  const image = "images/cookies.webp";
  addToCart(name, price, image);
}

function addClassicToCart() {
  const select = document.getElementById("classic-option");
  const value = select.value;

  let name, price;

  if (value === "Sandwich") {
    name = "Sandwich";
    price = 12.00;
    img_src= "images/classic_rectangle.webp";
  } else {
    name = "Boule";
    price = 12.00;
    img_src= "images/classic_round.webp";
  }
  const image = img_src
  addToCart(name, price, image);
}


function addFlourToCart(type) {
  let selectId = "";
  let image = "";
  let pricePerLb = 0;

  switch (type) {
    case "Hard Red Wheat Flour":
      selectId = "red-wheat-option";
      image = "images/hard-red-flour.jpeg";
      pricePerLb = 3;
      break;
    case "Hard White Wheat Flour":
      selectId = "white-wheat-option";
      image = "images/hard-white-flour.jpeg";
      pricePerLb = 3;
      break;
    case "Soft White Wheat Flour":
      selectId = "soft-wheat-option";
      image = "images/soft-white-flour.jpeg";
      pricePerLb = 2;
      break;
  }

  const selected = document.getElementById(selectId).value;
  const weight = parseFloat(selected);
  const price = (weight * pricePerLb).toFixed(2);
  const itemName = `${type} (${weight} lb)`;

  // Tag item so it doesn't count toward slot limit
  const cart = JSON.parse(localStorage.getItem("cart")) || [];
  cart.push({ name: itemName, price: parseFloat(price), quantity: 1, image, isFlour: true });
  localStorage.setItem("cart", JSON.stringify(cart));

  updateCartCount();
  showToast(`${itemName} added to cart.`);
}
