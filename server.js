require("dotenv").config();
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
//const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const createCsvWriter = require("csv-writer").createObjectCsvWriter;


const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});



const express = require("express");
const cors = require("cors");
const app = express();
app.use(cors({
  origin: ["https://matris-apothecary.up.railway.app","http://localhost:3000"],
  methods: ["GET", "POST"],
  credentials: true
}));

app.use(express.static(path.join(__dirname, "public")));


const ordersFilePath = "orders.csv"; // Store orders here
const csvFilePath = "email_subscribers.csv"; // Store opted-in emails

// ---- Shipping config (edit amounts as you like) ----
const SHIPPING_FEES = {
  pickup: 0.00,
  flat: 5.00,              // default if shipping with no specific method
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
  EMAIL_USER: process.env.EMAIL_USER ? "✅ set" : "❌ missing",
});


app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  console.log("⚡ Incoming webhook request received.");
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    console.log("✅ Webhook Event Received:", event.type);
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Process only successful payments
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    console.log("✅ Payment received! Processing order:", session);

    const email = session.customer_email;
    const metadata = session.metadata;

    // ✅ Safe parsing of totalAmount
    const rawAmount = parseFloat(metadata.totalAmount);
    const total_price = isNaN(rawAmount) ? 0.00 : parseFloat(rawAmount.toFixed(2));

    const orderData = {
      email,
      pickup_day: metadata.pickup_day,
      items: JSON.parse(metadata.cart).map(item => `${item.name} (x${item.quantity})`).join(", "),
      total_price,
      payment_method: metadata.payment_method,
      email_opt_in: metadata.emailOptIn && metadata.emailOptIn === "true"
    };

    try {
      await saveOrderToDatabaseFromWebhook(orderData);
      console.log("✅ Order saved successfully to database!");
      await sendOrderConfirmationEmail(orderData.email, orderData.items, orderData.pickup_day, orderData.total_price, orderData.payment_method);
      console.log("✅ Confirmation email sent successfully!");
    } catch (error) {
      console.error("❌ Error processing order:", error);
      return res.status(500).send("Error processing order.");
    }
  }

  res.json({ received: true });
});


app.use(express.json());


// ✅ Setup Email Transporter (For Order Confirmation)
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});



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

async function getPickupLimitFromGoogleSheets(pickupDay) {
  try {
    const response = await fetch(sheetUrlNoCache());
    if (!response.ok) throw new Error("Failed to fetch Google Sheets");

    const csvText = await response.text();
    const rows = parseCsv(csvText).slice(1); // skip header

    for (const cols of rows) {
      const [date, limit] = cols;
      if (normalize(date) === normalize(pickupDay)) {
        return parseInt(limit, 10);
      }
    }
    return null; // Not found
  } catch (error) {
    console.error("❌ Error fetching from Google Sheets:", error);
    return null;
  }
}



app.get("/remaining-slots", async (req, res) => {
  const pickup_day = req.query.pickup_day;
  if (!pickup_day) return res.status(400).json({ error: "pickup_day required" });

  const pickupLimit = await getPickupLimitFromGoogleSheets(pickup_day);
  if (!pickupLimit) return res.status(404).json({ error: "Date not found" });

  try {
    const itemCountResult = await pool.query(`
      SELECT COALESCE(
        SUM( (elem->>'quantity')::int ) FILTER (WHERE (elem->>'name') !~* 'Flour' ),
        0
      ) AS total_items
      FROM (
        SELECT jsonb_array_elements(cart::jsonb) AS elem
        FROM orders
        WHERE shipping_date = $1
      ) t;
    `, [pickup_day]);

    const itemsAlreadyOrdered = parseInt(itemCountResult.rows[0].total_items || 0, 10);
    res.json({ pickupLimit, itemsAlreadyOrdered });
  } catch (err) {
    console.error("❌ Error computing remaining slots:", err);
    res.status(500).json({ error: "Failed to compute remaining slots" });
  }
});



// ✅ API Endpoint to Save Orders
app.post("/save-order", async (req, res) => {
  try {
    const {
      name,
      email,
      pickup_day,          // for pickup; stored in shipping_date
      total_price,         // subtotal from client (we'll add shipping_fee)
      payment_method,
      email_opt_in,
      cart,                // JSON array
      delivery_method,     // "pickup" | "shipping"
      shipping_method,     // e.g., "flat" | "usps_first_class" | "usps_priority"
      shipping_info        // { name, address, city, state, zip }
    } = req.body;

    // Basic validation
    if (!email || !total_price || !payment_method || !cart || !delivery_method) {
      return res.status(400).json({ success: false, error: "Missing required fields." });
    }
    if (delivery_method === "pickup" && !pickup_day) {
      return res.status(400).json({ success: false, error: "pickup_day is required for local pickup." });
    }

    // ---- Pickup availability check ----
    if (delivery_method === "pickup") {
      const pickupLimit = await getPickupLimitFromGoogleSheets(pickup_day);
      if (!pickupLimit) {
        return res.status(400).json({ success: false, error: `Pickup day '${pickup_day}' not found in availability.` });
      }

      const itemCountResult = await pool.query(`
        SELECT COALESCE(
          SUM( (elem->>'quantity')::int ) FILTER (WHERE (elem->>'name') !~* 'Flour' ), 0
        ) AS total_items
        FROM (
          SELECT jsonb_array_elements(cart::jsonb) AS elem
          FROM orders
          WHERE shipping_date = $1
        ) t;
      `, [pickup_day]);

      const itemsAlreadyOrdered = parseInt(itemCountResult.rows[0].total_items || 0, 10);
      const cartItemTotal = cart.reduce((sum, item) => (item.isFlour ? sum : sum + (item.quantity || 1)), 0);
      const remainingSlots = pickupLimit - itemsAlreadyOrdered;
      if (cartItemTotal > remainingSlots) {
        return res.status(400).json({
          success: false,
          error: `Only ${remainingSlots} pickup slots remain for ${pickup_day}. You have ${cartItemTotal} items in your cart.`
        });
      }
    }

    // ---- Server-side shipping fee + final total ----
    const methodKey = (shipping_method || (delivery_method === "shipping" ? "flat" : "pickup")).toLowerCase();
    const shipping_fee = Number.isFinite(SHIPPING_FEES[methodKey]) ? SHIPPING_FEES[methodKey] : 0;
    const subtotal = parseFloat(total_price) || 0;
    const final_total = parseFloat((subtotal + shipping_fee).toFixed(2));
    const emailOptInValue = email_opt_in === true;

    // ---- Insert into your existing columns ----
    const addr = shipping_info || {};
    const shippingDateValue = delivery_method === "pickup" ? pickup_day : null;

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
        null, // phone (add later if you collect it)
        delivery_method,
        addr.address || null,
        addr.city || null,
        addr.state || null,
        addr.zip || null,
        shippingDateValue,
        JSON.stringify(cart),
        payment_method,
        final_total,
        methodKey,
        shipping_fee,
        emailOptInValue
      ]
    );

    // Optional: confirmation email (build readable items from cart)
    if (emailOptInValue) {
      const itemsText = cart.map(i => `${i.name} (x${i.quantity || 1})`).join(", ");
      await sendOrderConfirmationEmail(
        email,
        itemsText,
        shippingDateValue || "N/A",
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
  const shipping_date = md.pickup_day || null;
  const delivery_method = shipping_date ? "pickup" : "shipping";
  const total = parseFloat(md.totalAmount || "0") || 0;

  const result = await pool.query(
    `INSERT INTO orders
      (email, delivery_method, shipping_date, cart, payment_method, total, created_at, email_opt_in)
     VALUES
      ($1,    $2,              $3,            $4,   $5,             $6,   NOW(),     $7)
     RETURNING *;`,
    [email, delivery_method, shipping_date, JSON.stringify(cart), "card", total, (md.emailOptIn === "true")]
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
  pickupDay,
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
      const prettyMethod = shippingMethod.replace(/_/g, " ");
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
    // Pickup
    return `
      <p><strong>Fulfillment:</strong> Local Pickup</p>
      <p><strong>Pickup Date:</strong> ${pickupDay}*</p>
      <p>*Please pickup your order within your pickup window.</p>
      <p>You can pickup your order from the porch at Address</p>
    `;
  })();

  const header = `<p>Thank you for your order!</p>`;
  const bodyCore = `
    <p><strong>You have purchased:</strong></p>
    <p>${orderDetails}</p>
    ${fulfillmentLines}
    <p><strong>Total:</strong> $${Number(totalAmount).toFixed(2)}</p>
 
    <br>Thank you for your business! </br> <p>
    Feel free to email me with any questions or concerns by replying to this email.
    </p>
  `;

  const venmoWarning = `<p style="color: red; font-weight: bold;">⚠️ Your order will not be fulfilled until payment is received via Venmo.</p>`;

  const emailBody = paymentMethod === "Venmo"
    ? `${header}${bodyCore}${venmoWarning}`
    : `${header}${bodyCore}`;

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: email,
    cc: "matrisapothecary@gmail.com",
    subject: "Your Matris Apothecary Order Confirmation",
    html: emailBody,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log("✅ Order confirmation email sent to:", email);
  } catch (error) {
    console.error("❌ Error sending email:", error);
    console.error("❌ Mail Options:", mailOptions);
  }
}


// ✅ Stripe Checkout API
app.post("/create-checkout-session", async (req, res) => {
  try {
    console.log("🛠 Received Stripe checkout request:", req.body);

    const { cart, email, pickup_day, payment_method, emailOptIn } = req.body;

    if (!cart || !email || !pickup_day || !payment_method) {
      console.error("❌ Missing required fields:", { cart, email, pickup_day, payment_method });
      return res.status(400).json({ error: "Missing required fields for Stripe checkout." });
    }

    // ✅ Calculate subtotal
    const subtotal = cart.reduce((sum, item) => {
      const price = parseFloat(item.price);
      return sum + price * item.quantity;
    }, 0);

    // ✅ Calculate 3% fee
    const convenienceFee = parseFloat((subtotal * 0.03).toFixed(2));

    // ✅ Add fee as separate Stripe line item
    const lineItems = [
      ...cart.map(item => ({
        price_data: {
          currency: "usd",
          product_data: { name: item.name },
          unit_amount: Math.round(item.price * 100),
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
      }
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
        pickup_day,
        payment_method,
        emailOptIn: emailOptIn?.toString() || "false",
        totalAmount: (subtotal + convenienceFee).toFixed(2)  // 👈 Add this line
      }
    });

    console.log("✅ Stripe Session Created:", session.url);
    res.json({ url: session.url });

  } catch (error) {
    console.error("❌ Stripe Checkout Error:", error);
    res.status(500).json({ error: error.message });
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
