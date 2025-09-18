require("dotenv").config();
const fs = require("fs");
const path = require("path");
const createCsvWriter = require("csv-writer").createObjectCsvWriter;

const { Pool } = require("pg");
const express = require("express");
const cors = require("cors");

// If your Node runtime < 18, uncomment next two lines:
// const fetch = (...args) => import("node-fetch").then(({default: f}) => f(...args));
// global.fetch = fetch;

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// --- CORS (must be AFTER app is created, BEFORE routes) ---
const allowedOrigins = [
  "https://www.matrisapothecary.com",
  "https://matrisapothecary.com",                // optional bare domain
  "https://matris-apothecary.up.railway.app",
  "http://localhost:3000"
];

app.use(cors({
  origin: function (origin, callback) {
    // allow server-to-server/no-origin, and known browser origins
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// Preflight
app.options("*", cors());

app.use(express.static(path.join(__dirname, "public")));



const ordersFilePath = "orders.csv"; // Store orders here
const csvFilePath = "email_subscribers.csv"; // Store opted-in emails

// ---- Shipping config (edit amounts as you like) ----
const SHIPPING_FEES = {
  pickup: 0.00,
  flat: 7.00,              // default if shipping with no specific method
  usps_first_class: 5.00,
  usps_priority: 9.00
};

// Put near your SHIPPING_FEES:
const DISCOUNT_CODES = {
  ICON10: 0.10,   // 10% off items
  TEST100: 1.00   // 100% off items (may make total $0 — see guard below)
};

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// ---- Google Sheet (Publish-to-Web CSV) ----
const SHEET_CSV = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRLeiHAcr4m4Q_4yFuZXtxlj_kqc6V8ZKaPOgsZS0HHCZReMr-vTX2KEXOB8qqgduHPZLsbIF281YoA/pub?gid=0&single=true&output=csv";
const sheetUrlNoCache = () => `${SHEET_CSV}&cb=${Date.now()}`; // avoid stale caches

const normalize = (s) => String(s || "").trim().replace(/\s+/g, " ");
function parseCsv(text) {
  return text.trim().split(/\r?\n/).map(line =>
    (line.match(/("([^"]|"")*"|[^,]+)/g) || [])
      .map(c => c.replace(/^"|"$/g, "").replace(/""/g, '"'))
  );
}

// ✅ Stripe Webhook for Payment Confirmation
// Webhook endpoint for Stripe
console.log("🚀 Starting Matris Apothecary server...")
console.log("🧪 ENV: ", {
  PORT: process.env.PORT,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ? "✅ set" : "❌ missing",
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET ? "✅ set" : "❌ missing",
  DATABASE_URL: process.env.DATABASE_URL ? "✅ set" : "❌ missing",
  SENDGRID_API_KEY: process.env.SENDGRID_API_KEY ? "✅ set" : "❌ missing",
  EMAIL_FROM: process.env.EMAIL_FROM ? "✅ set" : "❌ missing",
});


// ✅ Stripe Webhook (must be BEFORE app.use(express.json()))
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  console.log("⚡ Incoming Stripe webhook");
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
    console.log("✅ Webhook verified:", event.type);
  } catch (err) {
    console.error("❌ Webhook verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const md = session.metadata || {};

        // Pull essentials
        const email           = session.customer_email || md.email;
        const deliveryMethod  = md.delivery_method || (md.pickup_day ? "pickup" : "shipping") || "pickup";
        const shippingMethod  = md.shipping_method || (deliveryMethod === "shipping" ? "flat" : "pickup");
        const shippingFee     = parseFloat(md.shipping_fee || "0") || 0;
        const paymentMethod   = md.payment_method || "Card";

        // Total from Stripe if possible
        const totalAmount = typeof session.amount_total === "number"
          ? session.amount_total / 100
          : parseFloat(md.totalAmount || "0") || 0;

        // Items (for the email body)
        let itemsText = "";
        try {
          const cart = JSON.parse(md.cart || "[]");
          itemsText = cart.map(i => `${i.name} (x${i.quantity || 1})`).join(", ");
        } catch (_) {
          itemsText = "";
        }

        // ✅ Build shipping info for email display (prefer Stripe shipping_details, fallback to metadata.shipping_info)
        const mdShip = md.shipping_info ? safelyParse(md.shipping_info) : null;
        const shippingInfoForEmail =
          (deliveryMethod === "shipping")
            ? {
                name:    session.shipping_details?.name                     || mdShip?.name    || "",
                address: session.shipping_details?.address?.line1           || mdShip?.address || "",
                city:    session.shipping_details?.address?.city            || mdShip?.city    || "",
                state:   session.shipping_details?.address?.state           || mdShip?.state   || "",
                zip:     session.shipping_details?.address?.postal_code     || mdShip?.zip     || ""
              }
            : null;

        // Save order (DB)
        await saveOrderToDatabaseFromWebhook(session);
        console.log("✅ Order saved from webhook");

        // ✅ Send confirmation email with the address block
        await sendOrderConfirmationEmail(
          email,
          itemsText,
          totalAmount,
          paymentMethod,
          deliveryMethod,
          shippingMethod,
          shippingFee,
          shippingInfoForEmail
        );
        console.log("✅ Confirmation email sent");
        break;
      }

      default:
        console.log("ℹ️ Unhandled event type:", event.type);
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("❌ Error handling webhook event:", err);
    return res.status(500).send("Webhook handler error");
  }
});


app.use(express.json());


const sgMail = require("@sendgrid/mail");
sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const EMAIL_FROM = process.env.EMAIL_FROM || "no-reply@matrisapothecary.com";




// ✅ Retry connecting to PostgreSQL before failing
async function setupDatabase(retries = 5, delay = 5000) {
  for (let i = 0; i < retries; i++) {
    try {
      const client = await pool.connect();
      console.log("✅ Database connected successfully!");

      await client.query(`
  CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    delivery_method TEXT,                 -- 'pickup' | 'shipping'
    address TEXT,
    city TEXT,
    state TEXT,
    zip TEXT,
    shipping_date TEXT,                   -- keep NULL for pickup; you coordinate later
    cart TEXT,                            -- JSON string
    payment_method TEXT,                  -- 'Card' | 'Venmo'
    total NUMERIC(10,2),
    created_at TIMESTAMP DEFAULT NOW(),
    shipping_method TEXT,                 -- 'flat' | 'usps_first_class' | ...
    shipping_fee NUMERIC(10,2) DEFAULT 0,
    email_opt_in BOOLEAN DEFAULT FALSE
  );
`);


      // Ensure new columns exist (safe to run repeatedly)
      await client.query(`
        ALTER TABLE orders
          ADD COLUMN IF NOT EXISTS delivery_method TEXT,
          ADD COLUMN IF NOT EXISTS shipping_method TEXT,
          ADD COLUMN IF NOT EXISTS shipping_fee NUMERIC(10,2) DEFAULT 0;
      `);

      client.release();
      return;
    } catch (err) {
      console.error(`❌ Database connection attempt ${i + 1} failed. Retrying in ${delay / 1000} seconds...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  console.error("🚨 Database connection failed after multiple attempts. Exiting.");
  process.exit(1);
}


// ✅ Call the function to initialize the DB
setupDatabase();


// ✅ Function to Save Orders in PostgreSQL
async function saveOrderToDatabase(order) {
  const query = `
      INSERT INTO orders (email, pickup_day, items, total_price, payment_method, email_opt_in, order_date)
      VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING *;
  `;
  const values = [order.email, order.pickup_day, order.items, order.total_price, order.payment_method, order.email_opt_in];

  try {
    const result = await pool.query(query, values);
    console.log("✅ Order saved to PostgreSQL successfully!", result.rows[0]);
    return result.rows[0];
  } catch (err) {
    console.error("❌ Error saving order to PostgreSQL:", err);
    console.error("❌ Query:", query);
    console.error("❌ Values:", values);
    throw err;

  }
}



// ✅ API Endpoint to Save Orders
app.post("/save-order", async (req, res) => {
  try {
    const {
      name,
      email,
      total_price,         // subtotal from client; server adds shipping_fee
      payment_method,
      email_opt_in,
      cart,                // JSON array
      delivery_method,     // "pickup" | "shipping"
      shipping_method,     // e.g., "flat" | "usps_first_class" | "usps_priority"
      shipping_info        // { name, address, city, state, zip } when shipping
    } = req.body;

    // Basic validation
    if (!email || !total_price || !payment_method || !cart || !delivery_method) {
      return res.status(400).json({ success: false, error: "Missing required fields." });
    }

    // ---- Server-side shipping fee + final total ----
    const SHIPPING_FEES = {
      pickup: 0.00,
      flat: 7.00,
      usps_first_class: 5.00,
      usps_priority: 9.00
    };
    const methodKey = (shipping_method || (delivery_method === "shipping" ? "flat" : "pickup")).toLowerCase();
    const shipping_fee = Number.isFinite(SHIPPING_FEES[methodKey]) ? SHIPPING_FEES[methodKey] : 0;
    const subtotal = parseFloat(total_price) || 0;
    const final_total = parseFloat((subtotal + shipping_fee).toFixed(2));
    const emailOptInValue = email_opt_in === true;

    // ---- Insert into DB ----
    const addr = shipping_info || {};
    const shippingDateValue = null; // We coordinate pickup later via email

    const result = await pool.query(
  `INSERT INTO orders
     (name, email, phone, delivery_method, address, city, state, zip,
      shipping_date, cart, payment_method, total, created_at,
      shipping_method, shipping_fee, email_opt_in)
   VALUES
     ($1,   $2,    $3,    $4,              $5,     $6,   $7,    $8,
      $9,            $10, $11,            $12,   NOW(),
      $13,            $14,          $15)
   RETURNING *;`,
  [
    name || email.split("@")[0],          // ensure NOT NULL
    email,
    null,                                 // phone (add if you collect it)
    delivery_method,
    addr.address || null,
    addr.city || null,
    addr.state || null,
    addr.zip || null,
    shippingDateValue,                    // null for pickup
    JSON.stringify(cart),
    payment_method,
    final_total,
    methodKey,
    shipping_fee,
    emailOptInValue
  ]
);

    // Optional: confirmation email
    if (emailOptInValue) {
      const itemsText = cart.map(i => `${i.name} (x${i.quantity || 1})`).join(", ");
      await sendOrderConfirmationEmail(
        email,
        itemsText,
        final_total,
        payment_method,
        delivery_method,
        methodKey,
        shipping_fee,
        shipping_info || null
      );
    }

    res.json({ success: true, order: result.rows[0] });
  } catch (error) {
    console.error("❌ Error saving order:", error);
    res.status(500).json({ success: false, error: error.message || "Failed to save order." });
  }
});


function safelyParse(json) {
  try { return JSON.parse(json); } catch { return null; }
}

async function saveOrderToDatabaseFromWebhook(session) {
  const md = session.metadata || {};
  const cd = session.customer_details || {};
  const sd = session.shipping_details || {};
  const mdShip = md.shipping_info ? safelyParse(md.shipping_info) : null;

  const email = session.customer_email || cd.email || md.email || null;
  const delivery_method = md.delivery_method || "pickup";
  const shipping_method = md.shipping_method || (delivery_method === "shipping" ? "flat" : "pickup");
  const shipping_fee = parseFloat(md.shipping_fee || "0") || 0;
  const emailOptIn = (md.emailOptIn === "true");
  const total = typeof session.amount_total === "number"
    ? session.amount_total / 100
    : parseFloat(md.totalAmount || "0") || 0;

  const name =
    sd.name ||
    cd.name ||
    (mdShip && mdShip.name) ||
    (email ? email.split("@")[0] : "Customer");

  const addrObj = sd.address || cd.address || (mdShip ? {
    line1: mdShip.address,
    city: mdShip.city,
    state: mdShip.state,
    postal_code: mdShip.zip
  } : null);

  const address = addrObj?.line1 || null;
  const city    = addrObj?.city || null;
  const state   = addrObj?.state || null;
  const zip     = addrObj?.postal_code || null;

  const cart = safelyParse(md.cart) || [];
  const shipping_date = null; // you’ll coordinate pickup later
  const phone = sd.phone || cd.phone || null;

  const result = await pool.query(
    `INSERT INTO orders
       (name, email, phone, delivery_method, address, city, state, zip,
        shipping_date, cart, payment_method, total, created_at,
        shipping_method, shipping_fee, email_opt_in)
     VALUES
       ($1,   $2,    $3,    $4,              $5,     $6,   $7,    $8,
        $9,            $10, $11,            $12,   NOW(),
        $13,            $14,          $15)
     RETURNING *;`,
    [
      name, email, phone, delivery_method, address, city, state, zip,
      shipping_date, JSON.stringify(cart), "card", total,
      shipping_method, shipping_fee, emailOptIn
    ]
  );

  return result.rows[0];
}


// tiny helper
function safelyParse(json) {
  try { return JSON.parse(json); } catch { return null; }
}






// ✅ API Endpoint to Fetch Orders
app.get("/get-orders", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM orders ORDER BY id DESC");
    
    console.log("✅ Orders fetched:", result.rows);

    res.json(result.rows);
  } catch (error) {
    console.error("❌ Error fetching orders:", error);
    res.status(500).json({ error: "Failed to load orders." });
  }
});



// ✅ Send Order Confirmation Email
async function sendOrderConfirmationEmail(
  email,
  items,
  totalAmount,
  paymentMethod,
  deliveryMethod = "pickup",
  shippingMethod = "pickup",
  shippingFee = 0,
  shippingInfo = null
) {
  if (!email) {
    console.error("❌ Email is missing. Cannot send confirmation.");
    return;
  }

  const orderDetails = items.split(", ").map(item => `• ${item}`).join("<br>");

  const fulfillmentLines = (() => {
    if (deliveryMethod === "shipping") {
      const prettyMethod = String(shippingMethod || "").replace(/_/g, " ");
      const addressHtml = shippingInfo
        ? `<p><strong>Ship To:</strong><br>
            ${shippingInfo.name || ""}<br>
            ${shippingInfo.address || ""}<br>
            ${shippingInfo.city || ""}, ${shippingInfo.state || ""} ${shippingInfo.zip || ""}
           </p>`
        : "";
      return `
        <p><strong>Fulfillment:</strong> Shipping</p>
        <p><strong>Shipping Method:</strong> ${prettyMethod} — $${Number(shippingFee).toFixed(2)}</p>
        ${addressHtml}
      `;
    }
    return `
    <p><strong>Fulfillment:</strong> Local Pickup</p>
    <p>We’ll email you shortly to coordinate a pickup date/time once your order is ready.</p>
  `;
  })();

  const header = `<p>Greetings!</p>`;
  const bodyCore = `
    <p><strong>You have purchased:</strong></p>
    <p>${orderDetails}</p>
    ${fulfillmentLines}
    <p><strong>Total:</strong> $${Number(totalAmount).toFixed(2)}</p>
    <br>Thank you for your business!</br>
    <p>Feel free to email me with any questions or concerns by replying to this email.</p>
  `;

  const venmoWarning = `<p style="color: red; font-weight: bold;">⚠️ Your order will not be fulfilled until payment is received via Venmo.</p>`;
  const html = (paymentMethod === "Venmo") ? `${header}${bodyCore}${venmoWarning}` : `${header}${bodyCore}`;

  // Plain-text fallback (very simple stripping)
  const text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .trim();

  const msg = {
    to: email,
    from: { email: EMAIL_FROM, name: "Matris Apothecary" },
    replyTo: EMAIL_FROM,
    cc: "matrisapothecary@gmail.com", // optional – keep if you want
    subject: "Your Matris Apothecary Order Confirmation",
    text,
    html,
  };

  try {
    await sgMail.send(msg);
    console.log("✅ Order confirmation email sent to:", email);
  } catch (error) {
    console.error("❌ Error sending email via SendGrid:", error?.response?.body || error);
  }
}



// ✅ Stripe Checkout API
app.post("/create-checkout-session", async (req, res) => {
  try {
    const {
      cart,
      email,
      payment_method,
      emailOptIn,
      delivery_method,
      shipping_method,
      shipping_info,          // keep sending this
      discount_code = ""
    } = req.body;

    if (!cart || !email || !payment_method) {
      return res.status(400).json({ error: "Missing required fields for Stripe checkout." });
    }

    const methodKey = (shipping_method || (delivery_method === "shipping" ? "flat" : "pickup")).toLowerCase();
    const shippingFee =
      delivery_method === "shipping"
        ? (Number.isFinite(SHIPPING_FEES[methodKey]) ? SHIPPING_FEES[methodKey] : 0)
        : 0;

    // apply discount server-side (items only)
    const rate = DISCOUNT_CODES[(discount_code || "").toUpperCase()] || 0;
    const discountedItems = cart.map(item => {
      const base = Number(item.price) || 0;
      const discounted = Math.max(base * (1 - rate), 0);
      return { ...item, discountedPrice: discounted };
    });

    const discountedSubtotal = discountedItems.reduce(
      (sum, i) => sum + (i.discountedPrice * (i.quantity || 1)),
      0
    );

    // 3% Stripe fee on the discounted subtotal
    const convenienceFee = Number((discountedSubtotal * 0.03).toFixed(2));

    // Guard for $0 total
    const grandTotal = discountedSubtotal + shippingFee + convenienceFee;
    if (Math.round(grandTotal * 100) <= 0) {
      return res.status(400).json({
        error: "Order total is $0 after discount. Use Venmo or place a manual/free order."
      });
    }

    const lineItems = [
      ...discountedItems.map(item => ({
        price_data: {
          currency: "usd",
          product_data: { name: item.name },
          unit_amount: Math.round(item.discountedPrice * 100),
        },
        quantity: item.quantity || 1,
      })),
      {
        price_data: {
          currency: "usd",
          product_data: { name: "Online Convenience Fee" },
          unit_amount: Math.round(convenienceFee * 100),
        },
        quantity: 1,
      },
      ...(delivery_method === "shipping" ? [{
        price_data: {
          currency: "usd",
          product_data: { name: `Shipping (${methodKey.replace(/_/g, " ")})` },
          unit_amount: Math.round(shippingFee * 100),
        },
        quantity: 1,
      }] : [])
    ];

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: lineItems,
      mode: "payment",
      success_url: "https://www.matrisapothecary.com/success.html",
      cancel_url: "https://www.matrisapothecary.com/cancel.html",
      customer_email: email,

      // ✅ Ask Stripe to collect the shipping address whenever shipping is chosen
      shipping_address_collection:
        delivery_method === "shipping" ? { allowed_countries: ["US"] } : undefined,

      metadata: {
        cart: JSON.stringify(cart),                          // original cart for emails/admin
        payment_method,
        delivery_method,
        shipping_method: methodKey,
        shipping_fee: shippingFee.toFixed(2),
        emailOptIn: emailOptIn?.toString() || "false",
        discount_code: (discount_code || "").toUpperCase(),
        // ✅ store discounted total for reference in webhook/email
        totalAmount: (discountedSubtotal + convenienceFee + shippingFee).toFixed(2),
        // ✅ carry the user-entered shipping info too (used as fallback)
        shipping_info: shipping_info ? JSON.stringify(shipping_info) : ""
      }
    });

    return res.json({ url: session.url });
  } catch (error) {
    console.error("❌ Stripe Checkout Error:", error);
    return res.status(500).json({ error: error.message });
  }
});





// ✅ Export Orders as CSV for Admin Download
// ✅ Export Orders as CSV for Admin Download (includes shipping columns)
app.get("/export-orders", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id, name, email, phone, delivery_method, address, city, state, zip,
        shipping_date, cart, payment_method, total, created_at,
        shipping_method, shipping_fee, email_opt_in
      FROM orders
      ORDER BY id DESC
    `);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "No orders found." });
    }

    const csvWriter = createCsvWriter({
      path: "orders.csv",
      header: [
        { id: "id",              title: "Order ID" },
        { id: "name",            title: "Name" },
        { id: "email",           title: "Email" },
        { id: "phone",           title: "Phone" },
        { id: "delivery_method", title: "Delivery Method" },
        { id: "address",         title: "Address" },
        { id: "city",            title: "City" },
        { id: "state",           title: "State" },
        { id: "zip",             title: "Zip" },
        { id: "shipping_date",   title: "Shipping/Pickup Date" },
        { id: "cart",            title: "Cart (JSON)" },
        { id: "payment_method",  title: "Payment Method" },
        { id: "total",           title: "Total" },
        { id: "created_at",      title: "Created At" },
        { id: "shipping_method", title: "Shipping Method" },
        { id: "shipping_fee",    title: "Shipping Fee" },
        { id: "email_opt_in",    title: "Email Opt-In" }
      ],
    });

    const formattedRows = result.rows.map(r => ({
      ...r,
      total: Number(r.total || 0).toFixed(2),
      shipping_fee: Number(r.shipping_fee || 0).toFixed(2),
      created_at: r.created_at ? new Date(r.created_at).toISOString() : "",
      cart: typeof r.cart === "string" ? r.cart : JSON.stringify(r.cart || [])
    }));

    await csvWriter.writeRecords(formattedRows);
    res.download("orders.csv");
  } catch (error) {
    console.error("❌ Error exporting orders:", error);
    res.status(500).json({ error: "Failed to export orders." });
  }
});



// ✅ Export Email Subscribers
app.get("/export-email-optins", async (req, res) => {
  try {
      const result = await pool.query("SELECT DISTINCT email FROM orders WHERE email_opt_in = TRUE");

      if (result.rows.length === 0) {
          return res.status(404).json({ message: "No opted-in emails found." });
      }

      const csvWriter = createCsvWriter({
          path: "opted_in_emails.csv",
          header: [{ id: "email", title: "Email" }],
      });

      await csvWriter.writeRecords(result.rows);
      console.log("✅ Opted-in emails exported successfully!");

      res.download("opted_in_emails.csv");

  } catch (error) {
      console.error("❌ Error exporting opted-in emails:", error);
      res.status(500).json({ error: "Failed to export opted-in emails." });
  }
});

app.get('/health', (req, res) => {
  res.status(200).send("OK");
});



// ✅ Start Server
const PORT = process.env.PORT || 8080;

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
