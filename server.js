require("dotenv").config();
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
//const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const createCsvWriter = require("csv-writer").createObjectCsvWriter;

const { Pool } = require("pg");
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

/*
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
      await saveOrderToDatabase(orderData);
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
*/

app.use(express.json());


// ✅ Setup Email Transporter (For Order Confirmation)
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ✅ Connect to Railway PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // Required for Railway
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

      client.release();
      return; // ✅ Exit if successful
    } catch (err) {
      console.error(`❌ Database connection attempt ${i + 1} failed. Retrying in ${delay / 1000} seconds...`);
      await new Promise((resolve) => setTimeout(resolve, delay)); // Wait before retrying
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
  const sheetURL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRLeiHAcr4m4Q_4yFuZXtxlj_kqc6V8ZKaPOgsZS0HHCZReMr-vTX2KEXOB8qqgduHPZLsbIF281YoA/pub?output=csv";

  try {
    const response = await fetch(sheetURL);
    if (!response.ok) throw new Error("Failed to fetch Google Sheets");

    const csvText = await response.text();
    const rows = csvText.trim().split("\n").slice(1);

    for (const row of rows) {
      const [date, limit] = row.split(",");
      if (date.trim() === pickupDay.trim()) {
        return parseInt(limit.trim());
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

  const itemCountResult = await pool.query(`
    SELECT COALESCE(SUM(quantity), 0) AS total_items
FROM (
  SELECT
    CAST(
      regexp_replace(subitem, '.*\\(x(\\d+)\\).*', '\\1')
      AS INTEGER
    ) AS quantity
  FROM (
    SELECT unnest(string_to_array(items, ',')) AS subitem
    FROM orders
    WHERE pickup_day = $1
  ) AS unwrapped
  WHERE subitem ~ '\\(x\\d+\\)'
    AND subitem NOT ILIKE '%Flour%'
) AS counted;

  `, [pickup_day]);

  const itemsAlreadyOrdered = parseInt(itemCountResult.rows[0].total_items || 0);
  res.json({ pickupLimit, itemsAlreadyOrdered });
});



// ✅ API Endpoint to Save Orders
app.post("/save-order", async (req, res) => {
  try {
    const { email, pickup_day, items, total_price, payment_method, email_opt_in, cart } = req.body;
    if (!email || !pickup_day || !items || !total_price || !payment_method || !cart) {
      return res.status(400).json({ success: false, error: "All fields are required!" });
    }

    // ✅ Fetch limit from Google Sheets
    const pickupLimit = await getPickupLimitFromGoogleSheets(pickup_day);
    if (!pickupLimit) {
      return res.status(400).json({ success: false, error: `Pickup day '${pickup_day}' not found in availability.` });
    }

    // ✅ Get total items already ordered for that day
    const itemCountResult = await pool.query(
      `
      SELECT COALESCE(SUM(quantity), 0) AS total_items
      FROM (
        SELECT
          CAST(
            regexp_replace(subitem, '.*\\(x(\\d+)\\).*', '\\1')
            AS INTEGER
          ) AS quantity
        FROM (
          SELECT unnest(string_to_array(items, ',')) AS subitem
          FROM orders
          WHERE pickup_day = $1
        ) AS unwrapped
        WHERE subitem ~ '\\(x\\d+\\)'
      ) AS counted;
      `,
      [pickup_day]
    );

    const itemsAlreadyOrdered = parseInt(itemCountResult.rows[0].total_items || 0);
    const cartItemTotal = cart.reduce((sum, item) => {
      return item.isFlour ? sum : sum + item.quantity;
    }, 0);



    const remainingSlots = pickupLimit - itemsAlreadyOrdered;

    if (cartItemTotal > remainingSlots) {
      return res.status(400).json({
        success: false,
        error: `Only ${remainingSlots} pickup slots remain for ${pickup_day}. You have ${cartItemTotal} items in your cart.`
      });
    }

    const emailOptInValue = email_opt_in === true;

    const result = await pool.query(
      `INSERT INTO orders (email, pickup_day, items, total_price, payment_method, email_opt_in, order_date)
       VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING *;`,
      [email, pickup_day, items, total_price, payment_method, emailOptInValue]
    );

    if (emailOptInValue) {
      await sendOrderConfirmationEmail(email, items, pickup_day, total_price, payment_method);
    }

    res.json({ success: true, order: result.rows[0] });
  } catch (error) {
    console.error("❌ Error saving order:", error);
    res.status(500).json({ success: false, error: error.message || "Failed to save order." });
  }
});




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
async function sendOrderConfirmationEmail(email, items, pickupDay, totalAmount, paymentMethod) {
  if (!email) {
    console.error("❌ Email is missing. Cannot send confirmation.");
    return;
  }

  const orderDetails = items.split(", ").map(item => `• ${item}`).join("<br>");
  let emailBody;

  if (paymentMethod === "Venmo") {
    emailBody = `
      <p>Thank you for your order!</p>
      <p><strong>You have purchased:</strong></p>
      <p>${orderDetails}</p>
      <p><strong>Pickup Date:</strong> ${pickupDay}*</p>
      <p>*Please pickup your bread within your pickup window. All unclaimed bread will be donated at the end of the day. 
</p>
      <p> You can pickup your order from the porch at 1508 Cooper Dr., Irving, Texas 75061. 
      <p></p>
      <p><strong>Total after Venmo discount:</strong> $${parseFloat(totalAmount).toFixed(2)}</p>
      <p style="color: red; font-weight: bold;">⚠️ Your order will not be fulfilled until payment is received via Venmo. Please complete your payment as soon as possible.</p>
      <br>
      <p>Thank you,</p>
      <p>Margaret</p>
      <br></br>
      
      <strong>Notes about bread storage: </strong> This bread is extremely fresh and free from all preservatives, which means it has a shorter shelf life than grocery store bread. 
<ul>
<li>Bread is best when consumed within 3-5 days.</li>
<li>Store bread in an airtight bag or beeswax bag.</li>
<li>Bread will keep well in the freezer for up to 1 month. </li>
<li>Slice the bread prior to freezing and use a toaster oven to reheat individual slices.</li>
<li>To reheat a whole frozen loaf, spritz with water and place in the oven at 400 for 20 minutes.</li> </ul>

    `;
  } else {
    emailBody = `
      <p>Thank you for your order!</p>
      <p><strong>You have purchased:</strong></p>
      <p>${orderDetails}</p>
      <p><strong>Pickup Date:</strong> ${pickupDay}*</p>
      <p>*Please pickup your bread within your pickup window. All unclaimed bread will be donated at the end of the day. 
</p>
      <p> You can pickup your order from the porch at 1508 Cooper Dr., Irving, Texas 75061. 
      <p></p>
      <br>
      <p>Thank you,</p>
      <p>Margaret</p>
      <br></br>
      
      <strong>Notes about bread storage: </strong> This bread is extremely fresh and free from all preservatives, which means it has a shorter shelf life than grocery store bread. 
<ul>
<li>Bread is best when consumed within 3-5 days.</li>
<li>Store bread in an airtight bag or beeswax bag.</li>
<li>Bread will keep well in the freezer for up to 1 month. </li>
<li>Slice the bread prior to freezing and use a toaster oven to reheat individual slices.</li>
<li>To reheat a whole frozen loaf, spritz with water and place in the oven at 400 for 20 minutes.</li> </ul>

    `;
  }

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: email, // ✅ Ensure `email` is valid before sending
    cc: "bascombreadco@gmail.com", 
    subject: "Your Bascom Bread Order Confirmation",
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

 /*
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
      success_url: "https://www.bascombreadco.com/success.html",
      cancel_url: "https://www.bascombreadco.com/cancel.html",
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

*/

app.get("/pickup-slot-status", async (req, res) => {
  const sheetURL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRLeiHAcr4m4Q_4yFuZXtxlj_kqc6V8ZKaPOgsZS0HHCZReMr-vTX2KEXOB8qqgduHPZLsbIF281YoA/pub?output=csv";
  try {
    const response = await fetch(sheetURL);
    const csvText = await response.text();
    const rows = csvText.trim().split("\n").slice(1); // Skip header

    const allDays = rows.map(row => {
      const [date, available] = row.split(",");
      return { date: date.trim(), available: parseInt(available.trim()) };
    });

    const query = await pool.query(`
      SELECT pickup_day,
        SUM(CAST(regexp_replace(subitem, '.*\\(x(\\d+)\\).*', '\\1') AS INTEGER)) AS items_ordered
      FROM (
        SELECT pickup_day, unnest(string_to_array(items, ',')) AS subitem
        FROM orders
      ) AS flattened
      WHERE subitem ~ '\\(x\\d+\\)' AND subitem NOT ILIKE '%Flour%'
      GROUP BY pickup_day;
    `);

    const orderedMap = {};
    query.rows.forEach(row => {
      orderedMap[row.pickup_day.trim()] = parseInt(row.items_ordered);
    });

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
app.get("/export-orders", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, email, pickup_day, items, total_price, payment_method, order_date
      FROM orders
      ORDER BY id DESC
    `);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "No orders found." });
    }

    const csvWriter = createCsvWriter({
      path: "orders.csv",
      header: [
        { id: "id", title: "Order ID" },
        { id: "email", title: "Email" },
        { id: "pickup_day", title: "Pickup Day" },
        { id: "items", title: "Items" },
        { id: "total_price", title: "Total Price" },
        { id: "payment_method", title: "Payment Method" },
        { id: "order_date", title: "Order Date" },
      ],
    });

    // Format fields if needed
    const formattedRows = result.rows.map(row => ({
      ...row,
      total_price: parseFloat(row.total_price).toFixed(2),
      order_date: row.order_date?.toISOString() || ""
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
