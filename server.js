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
      req.body,                               // raw Buffer
      sig,
      process.env.STRIPE_WEBHOOK_SECRET       // from Stripe Dashboard
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

        // Pull essentials from session/metadata
        const email           = session.customer_email || md.email;
        const deliveryMethod  = md.delivery_method || (md.pickup_day ? "pickup" : "shipping") || "pickup";
        const shippingMethod  = md.shipping_method || (deliveryMethod === "shipping" ? "flat" : "pickup");
        const shippingFee     = parseFloat(md.shipping_fee || "0") || 0;
        const paymentMethod   = md.payment_method || "Card";

        // Prefer Stripe’s amount_total if present; otherwise fall back to metadata
        const totalAmount = typeof session.amount_total === "number"
          ? session.amount_total / 100
          : parseFloat(md.totalAmount || "0") || 0;

        // Build item list for the confirmation email from metadata.cart
        let itemsText = "";
        try {
          const cart = JSON.parse(md.cart || "[]");
          itemsText = cart.map(i => `${i.name} (x${i.quantity || 1})`).join(", ");
        } catch (_) {
          itemsText = "";
        }

        // Persist order (your helper will read from session.metadata as needed)
        await saveOrderToDatabaseFromWebhook(session);
        console.log("✅ Order saved from webhook");

        // Send confirmation
        await sendOrderConfirmationEmail(
          email,           // email
          itemsText,       // items (string list)
          totalAmount,     // total amount NUMBER
          paymentMethod,   // "Card" / "Venmo" etc.
          deliveryMethod,  // "pickup" | "shipping"
          shippingMethod,  // "flat" | "pickup" | ...
          shippingFee,     // numeric shipping fee
          null             // shippingInfo (optional; include if you capture it)
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
          timestamp TIMESTAMP DEFAULT NOW(),
          name TEXT,
          email TEXT,
          pickup_day TEXT,
          items TEXT,
          total_price NUMERIC(10,2),
          payment_method TEXT,
          email_opt_in BOOLEAN DEFAULT FALSE,
          order_date TIMESTAMP DEFAULT NOW()
        )
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
         shipping_date, cart, payment_method, total, created_at, shipping_method, shipping_fee, email_opt_in)
       VALUES
        ($1,   $2,    $3,    $4,              $5,     $6,   $7,    $8,
         $9,            $10, $11,            $12,   NOW(),   $13,            $14,          $15)
       RETURNING *;`,
      [
        name || null,
        email,
        null, // phone (not collected yet)
        delivery_method,
        addr.address || null,
        addr.city || null,
        addr.state || null,
        addr.zip || null,
        shippingDateValue,                 // always null for now
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


async function saveOrderToDatabaseFromWebhook(session) {
  const md = session.metadata || {};
  const email = session.customer_email || md.email;
  const cart = JSON.parse(md.cart || "[]");
  const delivery_method = md.delivery_method || "pickup";
  const total = parseFloat(md.totalAmount || "0") || 0;
  const shipping_method = md.shipping_method || null;
  const shipping_fee = parseFloat(md.shipping_fee || "0") || 0;
  const emailOptIn = (md.emailOptIn === "true");

  // NOTE: Requires columns: cart (json/text), shipping_method, shipping_fee
  const result = await pool.query(
    `INSERT INTO orders
      (email, delivery_method, cart, payment_method, total, created_at, email_opt_in, shipping_method, shipping_fee)
     VALUES
      ($1,    $2,              $3,   $4,            $5,    NOW(),    $6,           $7,              $8)
     RETURNING *;`,
    [email, delivery_method, JSON.stringify(cart), "card", total, emailOptIn, shipping_method, shipping_fee]
  );
  return result.rows[0];
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

  const header = `<p>Thank you for your order!</p>`;
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
// ✅ Stripe Checkout API
app.post("/create-checkout-session", async (req, res) => {
  try {
    const {
      cart,
      email,
      payment_method,
      emailOptIn,
      delivery_method,       // "pickup" | "shipping"
      shipping_method        // e.g. "flat" | "usps_first_class" | ...
    } = req.body;

    if (!cart || !email || !payment_method) {
      return res.status(400).json({ error: "Missing required fields for Stripe checkout." });
    }

    // Subtotal from items (server = source of truth)
    const subtotal = cart.reduce((sum, item) => {
      const unit = parseFloat(item.price);
      return sum + unit * (item.quantity || 1);
    }, 0);

    // 3% convenience fee (waived for Venmo only; this is Stripe checkout)
    const convenienceFee = parseFloat((subtotal * 0.03).toFixed(2));

    // Shipping fee (server-side)
    const methodKey = (shipping_method || (delivery_method === "shipping" ? "flat" : "pickup")).toLowerCase();
    const shippingFee =
      delivery_method === "shipping"
        ? (Number.isFinite(SHIPPING_FEES[methodKey]) ? SHIPPING_FEES[methodKey] : 0)
        : 0;

    // Build Stripe line items
    const lineItems = [
      ...cart.map(item => ({
        price_data: {
          currency: "usd",
          product_data: { name: item.name },
          unit_amount: Math.round(parseFloat(item.price) * 100),
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
      metadata: {
        cart: JSON.stringify(cart),
        payment_method,
        delivery_method,
        shipping_method: methodKey,
        shipping_fee: shippingFee.toFixed(2),
        emailOptIn: emailOptIn?.toString() || "false",
        totalAmount: (subtotal + convenienceFee + shippingFee).toFixed(2)
      }
    });

    return res.json({ url: session.url });
  } catch (error) {
    console.error("❌ Stripe Checkout Error:", error);
    return res.status(500).json({ error: error.message });
  }
});



app.get("/pickup-slot-status", async (req, res) => {
  try {
    // 1) Read published CSV
    const response = await fetch(sheetUrlNoCache());
    if (!response.ok) throw new Error("Failed to fetch Google Sheets");
    const csvText = await response.text();
    const rows = parseCsv(csvText).slice(1); // Skip header
    const allDays = rows.map(cols => {
      const [date, available] = cols;
      return { date: normalize(date), available: parseInt(available, 10) || 0 };
    });

    // 2) Sum non-Flour quantities grouped by shipping_date from JSON cart
    const query = await pool.query(`
      SELECT shipping_date,
             SUM( (elem->>'quantity')::int ) FILTER (WHERE (elem->>'name') !~* 'Flour' ) AS items_ordered
      FROM (
        SELECT shipping_date, jsonb_array_elements(cart::jsonb) AS elem
        FROM orders
        WHERE shipping_date IS NOT NULL
      ) t
      GROUP BY shipping_date;
    `);

    const orderedMap = {};
    query.rows.forEach(row => {
      if (row.shipping_date) {
        orderedMap[normalize(row.shipping_date)] = parseInt(row.items_ordered, 10) || 0;
      }
    });

    // 3) Merge
    const result = allDays.map(day => {
      const ordered = orderedMap[day.date] || 0;
      return {
        date: day.date,
        available: day.available,
        ordered,
        remaining: day.available - ordered
      };
    });

    res.json(result);
  } catch (err) {
    console.error("❌ Error building pickup-slot-status:", err);
    res.status(500).json({ error: "Failed to get pickup slot status" });
  }
});


// ✅ Export Orders as CSV for Admin Download
// ✅ Export Orders as CSV for Admin Download (includes shipping columns)
app.get("/export-orders", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        name,
        email,
        pickup_day,
        delivery_method,
        shipping_method,
        shipping_fee,
        items,
        total_price,
        payment_method,
        order_date
      FROM orders
      ORDER BY id DESC
    `);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "No orders found." });
    }

    const csvWriter = createCsvWriter({
      path: "orders.csv",
      header: [
        { id: "id",               title: "Order ID" },
        { id: "name",             title: "Name" },
        { id: "email",            title: "Email" },
        { id: "pickup_day",       title: "Pickup Day" },
        { id: "delivery_method",  title: "Delivery Method" },   // pickup | shipping
        { id: "shipping_method",  title: "Shipping Method" },   // flat | usps_first_class | ...
        { id: "shipping_fee",     title: "Shipping Fee" },
        { id: "items",            title: "Items" },
        { id: "total_price",      title: "Total Price" },       // final total (includes shipping)
        { id: "payment_method",   title: "Payment Method" },
        { id: "order_date",       title: "Order Date" },
      ],
    });

    const formattedRows = result.rows.map(row => ({
      id: row.id,
      name: row.name || "",
      email: row.email || "",
      pickup_day: row.pickup_day || "",
      delivery_method: row.delivery_method || "",
      shipping_method: row.shipping_method || "",
      shipping_fee: Number(row.shipping_fee || 0).toFixed(2),
      items: row.items || "",
      total_price: Number(row.total_price || 0).toFixed(2),
      payment_method: row.payment_method || "",
      order_date: row.order_date ? row.order_date.toISOString() : ""
    }));

    await csvWriter.writeRecords(formattedRows);
    console.log("✅ Orders exported successfully!");

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
